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
	const harness = new UiHarness(() => AnsweredCard(question));
	try {
		const folded = harness.snapshot();
		expect(folded).toContain("Try it");
		expect(folded).toContain("2 of 3 answered");
		expect(folded).toContain("Good · single, multi · —");
		expect(folded).not.toContain("looks:");
		harness.action(harness.find(node => node.props().role === "omp.ask.card.head"), "toggle");
		const open = harness.snapshot();
		expect(open).toContain("Context paragraph.");
		expect(open).toContain("How does it look?");
		expect(open).toContain("Anything else?");
		expect(open).toContain("No answer");
		expect(harness.findAll(node => node.props().role === "omp.ask.pill")).toHaveLength(3);
	} finally { harness.dispose(); }
});
