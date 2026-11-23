import { afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { type as arktype } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import type {
	BeforeAgentStartEventResult,
	ContextEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	ToolDefinition,
} from "@oh-my-pi/pi-coding-agent";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import * as terminal from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import asyncAsk from "../src/index";
import goalPolicy from "../src/prompts/goal-policy.md" with { type: "text" };
import { EVENT_TYPE, type QuestionEvent } from "../src/state";
import { QuestionInbox } from "../src/ui";
import { input, journal } from "./helpers";

beforeAll(async () => {
	await initTheme(false);
});
const cleanupFixtures: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanupFixtures.splice(0)) await cleanup();
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fixture() {
	const log = journal();
	const handlers = new Map<string, Handler>();
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const sent: unknown[] = [];
	const active: string[] = [];
	let sessionId = "a";
	let mode = "tui";
	let kind = "main";
	let hasUI = true;
	let openCount = 0;
	let component: Component | undefined;
	let widget: (Component & { dispose?: () => void }) | undefined;
	const ui = {
		setWidget: (_key: string, content: Parameters<ExtensionUIContext["setWidget"]>[1]) => {
			widget?.dispose?.();
			widget =
				typeof content === "function" ? content({ requestRender: () => {} } as never, {} as never) : undefined;
		},
		notify: () => {},
		custom: (factory: Parameters<ExtensionUIContext["custom"]>[0], options?: { signal?: AbortSignal }) => {
			openCount++;
			const result = Promise.withResolvers<unknown>();
			const host = { terminal: { rows: 30 }, requestRender: () => {} };
			component = factory(host as never, {} as never, {} as never, result.resolve) as Component;
			options?.signal?.addEventListener("abort", () => result.reject(new Error("aborted")), { once: true });
			return result.promise;
		},
	};
	const ctx = {
		get mode() {
			return mode;
		},
		get hasUI() {
			return hasUI;
		},
		cwd: process.cwd(),
		get agent() {
			return { kind };
		},
		ui,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => log.entries },
		isIdle: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const api = {
		arktype,
		logger,
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
			commands.set(name, command),
		on: (name: string, handler: Handler) => handlers.set(name, handler),
		appendEntry: (customType: string, event: QuestionEvent) => {
			expect(customType).toBe(EVENT_TYPE);
			log.append(event);
		},
		sendMessage: (message: unknown) => sent.push(message),
		getActiveTools: () => active,
		setActiveTools: async (names: string[]) => {
			active.splice(0, active.length, ...names);
		},
	} as unknown as ExtensionAPI;
	asyncAsk(api);
	cleanupFixtures.push(() => handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx));
	return {
		ctx,
		log,
		tools,
		commands,
		sent,
		active,
		emit: (name: string, event: unknown = { type: name }) => handlers.get(name)?.(event, ctx),
		setMode: (next: string) => {
			mode = next;
		},
		setKind: (next: string) => {
			kind = next;
		},
		setHasUI: (next: boolean) => {
			hasUI = next;
		},
		switchSession: () => {
			sessionId = "b";
		},
		opened: () => openCount,
		component: () => component,
		widget: () => widget,
	};
}

test("policy appends before any question without mutating or accumulating on the host prompt", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	const base = Object.freeze(["Host policy", "Earlier extension policy"]);
	for (let preparation = 0; preparation < 2; preparation++) {
		const result = (await fx.emit("before_agent_start", {
			type: "before_agent_start",
			reason: "prompt",
			prompt: "Continue the task",
			systemPrompt: base,
		})) as BeforeAgentStartEventResult;
		expect(result.systemPrompt).toEqual([...base, goalPolicy]);
		expect(result.systemPrompt?.at(-1)).toStartWith("## Goal persistence and non-blocking questions\n\n");
	}
	expect(fx.log.entries).toEqual([]);
});

test("unavailable inbox sessions receive no goal policy directing them to ask_async", async () => {
	const fx = fixture();
	const event = {
		type: "before_agent_start",
		reason: "prompt",
		prompt: "Continue the task",
		systemPrompt: ["Host policy"],
	};
	fx.setMode("rpc");
	expect(await fx.emit("before_agent_start", event)).toBeUndefined();
	fx.setMode("tui");
	fx.setKind("sub");
	expect(await fx.emit("before_agent_start", event)).toBeUndefined();
	fx.setKind("main");
	fx.setHasUI(false);
	expect(await fx.emit("before_agent_start", event)).toBeUndefined();
});

test("the real agent loop completes independent work with multiple questions still unanswered", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	const tool = fx.tools[0]!;
	const executed: string[] = [];
	const questionTool: AgentTool = {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
		execute: (id, args, signal, update) => tool.execute(id, args, signal, update, fx.ctx),
	};
	const independent: AgentTool = {
		name: "independent",
		label: "Independent work",
		description: "Test fixture operation",
		parameters: arktype({}),
		async execute() {
			executed.push("completed");
			return { content: [{ type: "text", text: "completed" }], details: {} };
		},
	};
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "one", name: "ask_async", arguments: { op: "create", ...input } }] },
			{
				content: [
					{
						type: "toolCall",
						id: "two",
						name: "ask_async",
						arguments: { op: "create", ...input, title: "Second" },
					},
				],
			},
			{ content: [{ type: "toolCall", id: "three", name: "independent", arguments: {} }] },
			{ content: ["Independent work completed; dependent deployment remains pending."] },
		],
	});
	const agent = new Agent({
		initialState: { model: mock.model, systemPrompt: [], tools: [questionTool, independent], messages: [] },
		streamFn: mock.stream,
	});
	await agent.prompt("Run the scripted acceptance scenario.");
	expect(executed).toEqual(["completed"]);
	const listed = await tool.execute("list", { op: "list" }, undefined, undefined, fx.ctx);
	expect(listed.details).toMatchObject({ questions: [{ status: "pending" }, { status: "pending" }] });
	expect(fx.opened()).toBe(0);
	expect(fx.sent).toEqual([]);
	expect(fx.active).toContain("ask_async");
});

test("only an explicit user command opens the inbox and closing it submits nothing", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	await fx.tools[0]!.execute("one", { op: "create", ...input }, undefined, undefined, fx.ctx);
	const opened = fx.commands.get("questions")!.handler("", fx.ctx);
	expect(fx.opened()).toBe(1);
	fx.component()?.handleInput?.("\u001b");
	fx.component()?.handleInput?.("\u001b");
	await opened;
	expect(fx.sent).toEqual([]);
	expect(fx.log.entries).toHaveLength(1);
});

test("Questions widget exists only while pending; the command still opens answer history", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	expect(fx.widget()).toBeUndefined();
	const tool = fx.tools[0]!;
	const create = (key: string) => tool.execute(key, { op: "create", ...input, key }, undefined, undefined, fx.ctx);
	const withdraw = (id: string) =>
		tool.execute("withdraw", { op: "withdraw", id, reason: "Resolved" }, undefined, undefined, fx.ctx);
	const first = await create("first");
	const indicator = fx.widget();
	expect(indicator?.render(100).join("")).toContain("1 pending");
	await create("second");
	expect(fx.widget()).toBe(indicator);
	expect(indicator?.render(100).join("")).toContain("2 pending");
	await withdraw(arktype({ id: "string" }).assert(first.details).id);
	expect(fx.widget()?.render(100).join("")).toContain("1 pending");

	const opening = fx.commands.get("questions")!.handler("", fx.ctx);
	const inbox = fx.component();
	if (!(inbox instanceof QuestionInbox)) throw new Error("Expected the real question inbox");
	inbox.handleInput("staging");
	inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
	await opening;
	expect(fx.sent).toHaveLength(1);
	expect(fx.widget()).toBeUndefined();

	const history = fx.commands.get("questions")!.handler("", fx.ctx);
	const reopened = fx.component();
	if (!(reopened instanceof QuestionInbox)) throw new Error("Expected answer history");
	expect(reopened.debugState()).toMatchObject({ tab: "answered" });
	expect(fx.widget()).toBeUndefined();
	reopened.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	await history;

	const third = await create("third");
	expect(fx.widget()?.render(100).join("")).toContain("1 pending");
	await withdraw(arktype({ id: "string" }).assert(third.details).id);
	expect(fx.widget()).toBeUndefined();
});

test("switch invalidates an open inbox and does not inherit its pending questions", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	await fx.tools[0]!.execute("one", { op: "create", ...input }, undefined, undefined, fx.ctx);
	const opened = fx.commands.get("questions")!.handler("", fx.ctx);
	const old = fx.component();
	await fx.emit("session_before_switch");
	fx.switchSession();
	await fx.emit("session_switch");
	old?.handleInput?.("\r");
	await opened;
	const listed = await fx.tools[0]!.execute("list", { op: "list" }, undefined, undefined, fx.ctx);
	expect(listed.details).toMatchObject({ questions: [] });
	expect(fx.sent).toEqual([]);
});

test("headless and subagent calls fail instead of creating an invisible question", async () => {
	const fx = fixture();
	fx.setMode("rpc");
	await fx.emit("session_start");
	expect(fx.active).not.toContain("ask_async");
	expect((await fx.tools[0]!.execute("one", { op: "create", ...input }, undefined, undefined, fx.ctx)).isError).toBe(
		true,
	);
	fx.setMode("tui");
	fx.setKind("sub");
	expect((await fx.tools[0]!.execute("two", { op: "create", ...input }, undefined, undefined, fx.ctx)).isError).toBe(
		true,
	);
	expect(fx.log.entries).toEqual([]);
});

test("context restoration exposes pending dependencies without replaying questions as user answers", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	await fx.tools[0]!.execute("one", { op: "create", ...input }, undefined, undefined, fx.ctx);
	await fx.emit("session_switch");
	const result = (await fx.emit("context", { type: "context", messages: [] })) as ContextEventResult;
	expect(result.messages?.[0]?.role).toBe("custom");
	expect(JSON.stringify(result.messages)).toContain("Deploying the service");
	expect(fx.sent).toEqual([]);
	expect(fx.opened()).toBe(0);
});

test("pending questions own a native attention record until answered or withdrawn", async () => {
	const reports: string[] = [];
	const writer = spyOn(terminal, "writeTerminalSequence").mockImplementation(data => {
		reports.push(data);
	});
	const fx = fixture();
	terminal.setNativeRendering(true);
	try {
		await fx.emit("session_start");
		expect(reports).toEqual([]);
		const tool = fx.tools[0]!;
		const create = (id: string) =>
			tool.execute(id, { op: "create", ...input, key: id }, undefined, undefined, fx.ctx);
		const first = await create("first");
		await create("second");
		expect(reports).toEqual([
			"\x1b]7501;state=blocked:kind=question:id=omp-async-ask:app=omp:title=UXVlc3Rpb25z\x1b\\",
		]);
		const firstId = arktype({ id: "string" }).assert(first.details).id;
		await tool.execute("withdraw", { op: "withdraw", id: firstId, reason: "Resolved" }, undefined, undefined, fx.ctx);
		expect(reports).toHaveLength(1);
		const opening = fx.commands.get("questions")!.handler("", fx.ctx);
		const inbox = fx.component();
		if (!(inbox instanceof QuestionInbox)) throw new Error("Expected the real question inbox");
		inbox.handleInput("staging");
		inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
		// Use the native form's real action path, not a fabricated store transition.
		expect(fx.sent).toHaveLength(1);
		expect(reports.at(-1)).toBe("\x1b]7501;state=clear:id=omp-async-ask\x1b\\");
		// The final answer closes the real extension overlay without a shutdown event.
		await opening;
		await fx.emit("session_shutdown");
	} finally {
		await fx.emit("session_shutdown");
		terminal.setNativeRendering(false);
		writer.mockRestore();
	}
});

test("native attention follows rendering availability, restored questions and session ownership", async () => {
	const reports: string[] = [];
	const writer = spyOn(terminal, "writeTerminalSequence").mockImplementation(data => {
		reports.push(data);
	});
	const fx = fixture();
	terminal.setNativeRendering(false);
	try {
		await fx.emit("session_start");
		await fx.tools[0]!.execute("pending", { op: "create", ...input }, undefined, undefined, fx.ctx);
		expect(reports).toEqual([]);
		terminal.setNativeRendering(true);
		expect(reports).toHaveLength(1);
		expect(reports.at(-1)).toContain("state=blocked:kind=question:id=omp-async-ask");
		terminal.setNativeRendering(false);
		expect(reports.at(-1)).toBe("\x1b]7501;state=clear:id=omp-async-ask\x1b\\");
		terminal.setNativeRendering(true);
		expect(reports).toHaveLength(3);
		await fx.emit("session_start");
		expect(reports).toHaveLength(5);
		expect(reports.at(-2)).toBe("\x1b]7501;state=clear:id=omp-async-ask\x1b\\");
		expect(reports.at(-1)).toContain("state=blocked");
		expect(fx.widget()?.render(100).join("")).toContain("1 pending");
		await fx.emit("session_before_switch");
		expect(reports.at(-1)).toBe("\x1b]7501;state=clear:id=omp-async-ask\x1b\\");
		expect(fx.widget()).toBeUndefined();
		fx.switchSession();
		await fx.emit("session_switch");
		expect(reports).toHaveLength(6);
		expect(fx.widget()).toBeUndefined();
		await fx.emit("session_shutdown");
		terminal.setNativeRendering(false);
		terminal.setNativeRendering(true);
		expect(reports).toHaveLength(6);
	} finally {
		await fx.emit("session_shutdown");
		terminal.setNativeRendering(false);
		writer.mockRestore();
	}
});
