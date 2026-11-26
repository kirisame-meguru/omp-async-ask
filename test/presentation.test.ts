import { expect, test } from "bun:test";
import { UiNode } from "@oh-my-pi/pi-tui";
import type * as TranscriptTool from "@oh-my-pi/pi-coding-agent/ui/transcript/tool-block";
import type * as DefaultTool from "@oh-my-pi/pi-coding-agent/ui/tools/default";
import { legacyPresenter } from "@oh-my-pi/pi-coding-agent/ui/tools/legacy";
import { AnswerCard, questionRenderers, savedAnswerPresentation, summarizeAnswer } from "../src/presentation";
import type { Question } from "../src/state";
import { UiHarness } from "./ui-harness";

// Host-loading boundary: the package's static wildcard export appends .ts to these TSX components.
const { ToolBlock, ToolCall }: typeof TranscriptTool =
	await import(new URL("./ui/transcript/tool-block.tsx", import.meta.resolve("@oh-my-pi/pi-coding-agent")).href);
const { defaultPresenter }: typeof DefaultTool =
	await import(new URL("./ui/tools/default.tsx", import.meta.resolve("@oh-my-pi/pi-coding-agent")).href);

const question: Question = {
	id: "question", sessionId: "session", toolCallId: "call", createdAt: 1,
	title: "Preferences", blockedWork: "Select preferences", status: "answered",
	html: '<form><fieldset><legend>Features</legend><label><input type="checkbox" name="features" value="a" checked>Alpha &amp; beta</label><label><input type="checkbox" name="features" value="b">Gamma</label></fieldset><label>Region<select name="region"><option value="east">East region</option><option value="west">West region</option></select></label><label>Comment<textarea name="comment"></textarea></label><input type="hidden" name="internal" value="hidden-value"></form>',
	answer: { id: "answer", data: { features: ["b", "Custom choice"], region: "east", comment: "literal <tag>", internal: "hidden-value" }, notes: [
		{ name: "features", question: "Features", option: "Gamma", value: "b", text: "Please enable it" },
	] },
};

test("answer summaries map submitted choices, retain Other and notes, and omit hidden values and defaults", () => {
	const summary = summarizeAnswer(question);
	expect(summary.rows).toEqual([
		"Features: Gamma, Custom choice", "Region: East region", "Comment: literal <tag>",
		"Features — Gamma: Please enable it",
	]);
	const harness = new UiHarness(() => AnswerCard(summary, false, "Technical payload"));
	try {
		expect(harness.snapshot()).toContain("Gamma, Custom choice");
		expect(harness.snapshot()).not.toContain("Technical payload");
		expect(harness.terminal.screen().join("\n")).toContain("Gamma");
	} finally { harness.dispose(); }
	expect(JSON.stringify(summary)).not.toContain("hidden-value");
});

test("empty submissions never display recommended choices as answers", () => {
	expect(summarizeAnswer({ ...question, answer: { id: "answer", data: {}, notes: [] } }).rows).toEqual(["No values provided"]);
});

test("malformed historical presentation metadata defers instead of hiding the message", () => {
	for (const details of [undefined, {}, { presentation: { title: "Question", rows: [false] } }]) {
		expect(savedAnswerPresentation(details)).toBeUndefined();
	}
	expect(savedAnswerPresentation({ presentation: { title: "Question", rows: ["Answer"] } })).toEqual({ title: "Question", rows: ["Answer"] });
});

test("withdrawals, lists and errors show their actual state rather than a pending success", async () => {
	const renderers = questionRenderers(() => {});
	const options = { expanded: false, isPartial: false };
	for (const [result, args, expected] of [
		[{ content: [], details: { title: "Preferences", status: "withdrawn", reason: "No longer needed" } }, { op: "withdraw" }, ["Withdrawn", "No longer needed"]],
		[{ content: [], details: { questions: [{ title: "Preferences", status: "answered" }], errors: ["History unavailable"] } }, { op: "list" }, ["answered", "History unavailable"]],
		[{ content: [{ type: "text", text: "Invalid form" }], details: {}, isError: true }, { op: "create" }, ["Invalid form"]],
	] as const) {
		const mutable = { ...result, content: [...result.content] };
		const harness = new UiHarness(() => renderers.renderResult(mutable, options, undefined, args));
		try {
			const native = harness.snapshot();
			const ansi = harness.terminal.screen().join("\n");
			for (const text of expected) { expect(native).toContain(text); expect(ansi).toContain(text); }
			expect(native).not.toContain("Awaiting answer");
			if ("isError" in result) expect(native).not.toContain("Open questions");
		} finally {
			harness.dispose();
		}
	}
	expect(renderers.renderCall()).toBeUndefined();
});

test("the installed host renders one async heading through call/result composition", () => {
	const title = "Async question test";
	const heading = `Ask asynchronously · ${title}`;
	let opened = 0;
	const renderers = questionRenderers(() => { opened++; });
	let call!: InstanceType<typeof ToolCall>;
	const harness = new UiHarness(() => {
		call = new ToolCall({
			id: "async-call", name: "ask_async", label: "Ask asynchronously",
			args: { op: "create", title },
			presenter: legacyPresenter(renderers, defaultPresenter),
		});
		return new UiNode("col", { children: () => ToolBlock({ call }) });
	});
	const headings = () => harness.findAll(node => {
		const props = node.props();
		return node.kind === "text" && "text" in props && props.text === heading;
	});
	try {
		expect(headings()).toHaveLength(0); // Only the host's generic call header before a result.
		for (const expanded of [false, true]) {
			call.setExpanded(expanded);
			for (const result of [
				{ content: [], details: { title, status: "pending", blockedWork: "Choose a setting" } },
				{ content: [{ type: "text", text: "Invalid form" }], details: {}, isError: true },
				{ content: [], details: { title, status: "withdrawn", reason: "No longer needed" } },
			]) {
				call.updateResult(result, false);
				harness.terminal.render();
				expect(headings()).toHaveLength(1);
				harness.resize(15);
				expect(headings()).toHaveLength(1);
				harness.resize(30);
			}
		}
		harness.action(harness.find(node => {
			const props = node.props();
			return node.kind === "button" && "text" in props && props.text === "Open questions";
		}), "open");
		expect(opened).toBe(1);
	} finally { harness.dispose(); }
});
