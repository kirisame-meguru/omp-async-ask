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
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { CustomMessageComponent } from "@oh-my-pi/pi-tui/chat/custom-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { TspHarness } from "./tsp-harness";
import * as terminal from "@oh-my-pi/pi-tui";
import { logger } from "@oh-my-pi/pi-utils";
import asyncAsk from "../src/index";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { AVAILABLE, CONNECT, type AsyncQuestion, type QuestionSource } from "../src/bridge";
import goalPolicy from "../src/prompts/goal-policy.md" with { type: "text" };
import { ANSWER_TYPE, EVENT_TYPE, type QuestionEvent } from "../src/state";
import { QuestionInbox } from "../src/ui";
import { QuestionPanel } from "../src/panel";
import { input, journal } from "./helpers";

beforeAll(async () => {
	await initTheme(false);
});
const cleanupFixtures: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanupFixtures.splice(0)) await cleanup();
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function fixture(nativeHost?: TUI) {
	const log = journal();
	const handlers = new Map<string, Handler>();
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const renderers = new Map<string, MessageRenderer>();
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
			if (nativeHost && widget) nativeHost.removeChild(widget);
			widget?.dispose?.();
			widget =
				typeof content === "function" ? content(nativeHost ?? { requestRender: () => {} } as never, {} as never) : undefined;
			if (nativeHost && widget) nativeHost.addChild(widget);
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
		setTimeout: (callback: () => void) => setTimeout(callback, 0),
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const api = {
		events: new EventBus(),
		arktype,
		logger,
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerMessageRenderer: (type: string, renderer: MessageRenderer) => renderers.set(type, renderer),
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
		events: api.events,
		ctx,
		log,
		tools,
		commands,
		renderers,
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

test("source discovery works before or after owner startup and survives completed agent turns", async () => {
	for (const early of [true, false]) {
		const fx = fixture();
		let source: QuestionSource | undefined;
		let pending: readonly AsyncQuestion[] = [];
		const connect = () => fx.events.emit(CONNECT, {
			version: 1, sessionId: "a",
			accept(next: QuestionSource) {
				source = next;
				next.subscribe(questions => { pending = questions; });
			},
		});
		const off = fx.events.on(AVAILABLE, connect);
		if (early) connect();
		await fx.emit("session_start");
		if (!early) connect();
		await fx.tools[0]!.execute("bridge-question", { op: "create", ...input }, undefined, undefined, fx.ctx);
		await fx.emit("agent_end", { willContinue: false });
		expect(pending.map(question => question.toolCallId)).toEqual(["bridge-question"]);
		expect(fx.opened()).toBe(0);
		const cap = pending[0]!;
		await fx.emit("session_before_tree");
		expect(source!.signal.aborted).toBe(true);
		expect(cap.submitConfirmed({ target: "old" })).toEqual({ kind: "stale" });
		await fx.emit("session_tree");
		expect(pending[0]!.submitConfirmed({ target: "fresh" }).kind).toBe("accepted");
		expect(fx.sent).toHaveLength(1);
		off();
	}
});

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

test("native command opens the same retained dock panel without creating a modal", async () => {
	const harness = await TspHarness.start();
	try {
		const fx = fixture(harness.tui);
		await fx.emit("session_start");
		const created = await fx.tools[0]!.execute("one", { op: "create", ...input }, undefined, undefined, fx.ctx);
		const widget = fx.widget();
		expect(widget).toBeInstanceOf(QuestionPanel);
		await fx.commands.get("questions")!.handler("", fx.ctx);
		expect(fx.opened()).toBe(0);
		expect(fx.widget()).toBe(widget);
		await fx.tools[0]!.execute("withdraw", { op: "withdraw", id: arktype({ id: "string" }).assert(created.details).id, reason: "Resolved" }, undefined, undefined, fx.ctx);
		expect(fx.widget()).toBe(widget);
		await fx.emit("session_before_switch");
		expect(fx.widget()).toBeUndefined();
		widget?.handleNativeEvent?.({ type: "toggle", key: "panel", collapsed: true });
		expect(fx.sent).toEqual([]);
	} finally { harness.stop(); }
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
	const harness = await TspHarness.start();
	const fx = fixture(harness.tui);
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
		await fx.commands.get("questions")!.handler("", fx.ctx);
		await harness.render();
		const form = harness.find(node => node.k === "input")!;
		harness.event({ ev: "edit", sf: harness.terminal.surface!, id: form.id, from: 0, to: 0, text: "staging", cursor: 7, len: 0 });
		const submit = harness.find(node => node.k === "button" && node.p?.actions?.click === "submit")!;
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: submit.id, act: "submit", mods: [] });
		expect(fx.sent).toHaveLength(1);
		expect(reports.at(-1)).toBe("\x1b]7501;state=clear:id=omp-async-ask\x1b\\");
		expect(fx.opened()).toBe(0);
		await fx.emit("session_shutdown");
	} finally {
		await fx.emit("session_shutdown");
		harness.stop();
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

test("Tern question cards hide transport payloads and open the real inbox", async () => {
	const harness = await TspHarness.start();
	const fx = fixture(harness.tui);
	await fx.emit("session_start");
	const tool = fx.tools[0]!;
	const args = { op: "create", ...input };
	const result = await tool.execute("native-question", args, undefined, undefined, fx.ctx);
	const card = new ToolExecutionComponent(tool.name, args, {}, tool as unknown as AgentTool, harness.tui);
	card.setArgsComplete();
	card.updateResult(result);
	harness.tui.addChild(card);
	await harness.render();
	try {
		const drawn = JSON.stringify(harness.doc());
		expect(drawn).toContain(input.title);
		expect(drawn).toContain("Awaiting answer");
		expect(drawn).not.toContain("<form");
		expect(drawn).not.toContain("No user answer has been given");
		expect(drawn).not.toContain("blockedWork=");
		const button = harness.find(node => node.k === "button" && node.p?.text === "Open questions");
		expect(button).toBeDefined();
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: button!.id, act: "open", mods: [] });
		expect(fx.opened()).toBe(0);
		expect(fx.widget()).toBeInstanceOf(QuestionPanel);
		expect(harness.errors).toEqual([]);
		let source: QuestionSource | undefined;
		fx.events.emit(CONNECT, { version: 1, sessionId: "a", accept: (value: QuestionSource) => { source = value; } });
		let pending: readonly AsyncQuestion[] = [];
		source!.subscribe(value => { pending = value; });
		pending[0]!.submitConfirmed({ target: "stage" });
		harness.flush();
		expect(JSON.stringify(harness.doc())).toContain("Answered");
		expect(JSON.stringify(harness.doc())).not.toContain("Awaiting answer");
		await fx.emit("session_before_switch");
		fx.switchSession();
		await fx.emit("session_switch");
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: button!.id, act: "open", mods: [] });
		expect(fx.opened()).toBe(0);
		expect(fx.widget()).toBeUndefined();
	} finally {
		harness.stop();
	}
});

test("Tern answer cards show selected labels while preserving the full agent message", async () => {
	const fx = fixture();
	await fx.emit("session_start");
	let source: QuestionSource | undefined;
	fx.events.emit(CONNECT, { version: 1, sessionId: "a", accept: (value: QuestionSource) => { source = value; } });
	const question = {
		...input,
		title: "Choose a destination",
		html: '<form><fieldset><legend>Destination</legend><label><input type="radio" name="target" value="stage">Staging environment</label><label><input type="radio" name="target" value="prod">Production environment</label></fieldset><label>Notes<textarea name="notes"></textarea></label><label>Retries<input type="number" name="retries"></label></form>',
	};
	await fx.tools[0]!.execute("native-answer", { op: "create", ...question }, undefined, undefined, fx.ctx);
	let pending: readonly AsyncQuestion[] = [];
	source!.subscribe(value => { pending = value; });
	pending[0]!.submitConfirmed({ target: "stage", notes: "", retries: 0 });
	const message = { ...(fx.sent[0] as CustomMessage), role: "custom" as const, timestamp: 1 };
	const original = JSON.stringify(message);
	const harness = await TspHarness.start(tui => {
		tui.addChild(new CustomMessageComponent(message, fx.renderers.get(ANSWER_TYPE)));
	});
	try {
		const drawn = JSON.stringify(harness.doc());
		expect(drawn).toContain("Answer submitted");
		expect(drawn).toContain("Choose a destination");
		expect(drawn).toContain("Staging environment");
		expect(drawn).toContain("Retries: 0");
		expect(drawn).not.toContain("<form");
		expect(drawn).not.toContain("Question ID:");
		expect(drawn).not.toContain("User-submitted form values");
		expect(JSON.stringify(message)).toBe(original);
		expect(message.content).toContain(question.html);
		expect(message.content).toContain('"target": "stage"');
		const card = harness.find(node => node.p?.role === "async-ask.answer");
		expect(card).toBeDefined();
		harness.event({ ev: "toggle", sf: harness.terminal.surface!, id: card!.id, collapsed: false });
		expect(JSON.stringify(harness.doc())).toContain("Question ID:");
		expect(harness.errors).toEqual([]);
		// Existing sessions have only identity metadata; recover their labels from the owning journal.
		const { presentation: _presentation, ...legacyDetails } = message.details as Record<string, unknown>;
		const legacy = { ...message, details: legacyDetails };
		const renderer = fx.renderers.get(ANSWER_TYPE)!;
		expect(renderer(legacy, { expanded: false }, theme)?.render(100).join("\n")).toContain("Staging environment");
		await fx.emit("session_before_switch");
		fx.switchSession();
		await fx.emit("session_switch");
		expect(renderer(legacy, { expanded: false }, theme)).toBeUndefined();
		// New messages are self-contained even when their session is no longer connected.
		expect(renderer(message, { expanded: false }, theme)?.render(100).join("\n")).toContain("Staging environment");
	} finally {
		harness.stop();
	}
});
