import { signal, UiNode } from "@oh-my-pi/pi-tui";
import { answerDetail, type AnswerItem } from "./presentation";
import type { Question } from "./state";
import { clean, questionState } from "./ui";

/**
 * A settled question as a read-only version of the native Ask card: same roles as the pending form,
 * so the Answered tab inherits the host's card, fold and pill styling instead of bare text rows.
 */
export function AnsweredCard(question: Question, onRetry?: () => void): UiNode {
	const detail = answerDetail(question);
	const open = signal(false);
	const failed = question.delivery === "failed" || question.delivery === "unconfirmed";
	const tone = failed ? "warning" : question.status === "answered" ? "success" : "muted";
	const answered = detail.items.filter(item => item.values.length).length;
	const summary = detail.items.map(item => item.values.join(", ") || "—").join(" · ");
	const head = new UiNode("row", { role: "omp.ask.card.head", align: "baseline", gap: "sm", justify: "between",
		actions: { click: "toggle" }, onAction: () => open.update(value => !value), title: "Show answers", children: [
			new UiNode("text", { role: "omp.ask.card.tag", spans: [{ s: "accent", t: "ask" }] }),
			new UiNode("row", { gap: "sm", align: "baseline", children: [
				...(question.status === "answered" ? [new UiNode("text", { role: "omp.ask.card.progress",
					spans: [{ s: "muted", t: `${answered} of ${detail.items.length} answered` }] })] : []),
				new UiNode("text", { role: "omp.ask.card.progress", spans: [{ s: tone, t: questionState(question) }] }),
				...(failed && onRetry ? [new UiNode("button", { text: "Review resend…", size: "sm",
					actions: { click: "retry" }, onAction: onRetry })] : []),
			] }),
		] });
	return new UiNode("col", { role: "omp.ask.card", gap: "md", children: () => [
		head,
		new UiNode("text", { role: "omp.ask.heading", wrap: "word", spans: [{ t: clean(question.title) }] }),
		...(question.reason ? [new UiNode("text", { role: "omp.ask.text", wrap: "word", spans: [{ s: "muted", t: clean(question.reason) }] })] : []),
		...(question.answer ? open()
			? [new UiNode("col", { role: "omp.ask.card.body", gap: "lg", children: [
				...(detail.intro.length ? [new UiNode("col", { role: "omp.ask.intro", gap: "md", children: detail.intro.map(text =>
					new UiNode("text", { role: "omp.ask.text", wrap: "word", spans: [{ s: "muted", t: text }] })) })] : []),
				...detail.items.map(answerFold),
			] })]
			: [new UiNode("text", { role: "omp.ask.fold.answer", truncate: "end", lines: 1, actions: { click: "toggle" },
				onAction: () => open.set(true), spans: [{ s: "muted", t: summary }] })]
			: []),
	] }, question.id);
}

function answerFold(item: AnswerItem, index: number): UiNode {
	const empty = !item.values.length;
	const answer = empty
		? new UiNode("text", { role: "omp.ask.fold.answer", spans: [{ s: "dim", t: "No answer" }] })
		: item.choice
			? new UiNode("row", { role: "omp.ask.pills", gap: "xs", align: "center", wrap: true, children: item.values.map((label, i) =>
				new UiNode("button", { role: "omp.ask.pill", text: label, size: "sm", on: true, icon: "check" }, `p${i}`)) })
			: new UiNode("text", { role: "omp.ask.fold.answer", wrap: "word", spans: [{ t: item.values.join(", ") }] });
	return new UiNode("col", { role: "omp.ask.fold", gap: "xs", children: [
		new UiNode("row", { role: "omp.ask.fold.head", align: "baseline", gap: "sm", children: [
			new UiNode("text", { role: "omp.ask.fold.mark", spans: [empty ? { s: "muted", t: "○" } : { s: "success", t: "✓" }] }),
			new UiNode("text", { role: "omp.ask.fold.question", wrap: "word", spans: [{ t: item.prompt }] }),
		] }),
		answer,
		...item.notes.map(note => new UiNode("text", { role: "omp.ask.fold.note", wrap: "word",
			spans: [{ s: "dim", t: "✎ " }, { s: "em", t: note }] })),
	] }, `q${index}`);
}
