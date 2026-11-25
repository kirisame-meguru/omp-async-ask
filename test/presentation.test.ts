import { beforeAll, expect, test } from "bun:test";
import { col } from "@oh-my-pi/pi-tui/native/describe";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AnswerCard, questionRenderers, savedAnswerPresentation, summarizeAnswer } from "../src/presentation";
import type { Question } from "../src/state";
import { TspHarness } from "./tsp-harness";

beforeAll(async () => { await initTheme(false); });

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
	const ansi = new AnswerCard(summary, false, "Technical payload").render(100).join("\n");
	expect(ansi).toContain("Gamma, Custom choice");
	expect(ansi).not.toContain("Technical payload");
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
		[{ content: [{ type: "text", text: "Invalid form" }], isError: true }, { op: "create" }, ["Invalid form"]],
	] as const) {
		const mutable = { ...result, content: [...result.content] };
		const component = renderers.renderResult(mutable, options, undefined, args);
		const harness = await TspHarness.start(tui => tui.addChild({
			render: width => component.render(width),
			describe: () => col(renderers.describeResult(mutable, options, args).body ?? []),
		}));
		try {
			const native = JSON.stringify(harness.doc());
			const ansi = component.render(100).join("\n");
			for (const text of expected) { expect(native).toContain(text); expect(ansi).toContain(text); }
			expect(native).not.toContain("Awaiting answer");
			if ("isError" in result) expect(native).not.toContain("Open questions");
			expect(harness.errors).toEqual([]);
		} finally {
			harness.stop();
		}
	}
	expect(JSON.stringify(renderers.describeCall({}))).not.toContain("undefined");
});
