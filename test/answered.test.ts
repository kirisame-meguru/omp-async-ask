import { expect, test } from "bun:test";
import { UiHarness } from "./ui-harness";
import { AnsweredCard } from "../src/answered";
import { compileQuestions } from "../src/questions";
import type { Question } from "../src/state";

const question: Question = {
	id: "q1", sessionId: "s", toolCallId: "t", createdAt: 1, status: "answered", delivery: "recorded",
	title: "Try it", blockedWork: "Nothing",
	html: compileQuestions([
		{ id: "looks", prompt: "How does it look?", options: [{ value: "good", label: "Good" }, { value: "meh", label: "Meh" }] },
		{ id: "kinds", prompt: "Which kinds?", kind: "multi", options: [{ value: "single" }, { value: "multi" }] },
		{ id: "notes", prompt: "Anything else?", kind: "longtext" },
	], "Context paragraph."),
	answer: { id: "a", data: { looks: "good", kinds: ["single", "multi"], notes: "" }, notes: [] },
};

test("answered cards summarize when folded and show prompts, labels and blanks when opened", () => {
	const folded = new UiHarness(() => AnsweredCard(question, false, () => {}));
	try {
		const text = folded.snapshot();
		expect(text).toContain("Try it");
		expect(text).toContain("2 of 3 answered");
		expect(text).toContain("Good · single, multi · —");
		expect(text).not.toContain("looks:");
	} finally { folded.dispose(); }
	let toggled: boolean | undefined;
	const head = new UiHarness(() => AnsweredCard(question, false, next => { toggled = next; }));
	try {
		head.action(head.find(node => node.props().role === "omp.ask.card.head"), "expand");
		expect(toggled).toBe(true);
	} finally { head.dispose(); }
	const open = new UiHarness(() => AnsweredCard(question, true, () => {}));
	try {
		const text = open.snapshot();
		expect(text).toContain("Context paragraph.");
		expect(text).toContain("How does it look?");
		expect(text).toContain("No answer");
		expect(open.findAll(node => node.props().role === "omp.ask.pill")).toHaveLength(3);
	} finally { open.dispose(); }
});
