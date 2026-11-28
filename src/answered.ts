import { UiNode } from "@oh-my-pi/pi-tui";
import { answerDetail, type AnswerItem } from "./presentation";
import type { Question } from "./state";
import { clean, questionBlock, questionState } from "./ui";

/**
 * A settled question as a read-only version of the native Ask card: same roles as the pending form,
 * so the Answered tab inherits the host's card, fold and pill styling instead of bare text rows.
 */
export function AnsweredCard(question: Question, open: boolean, onToggle: (open: boolean) => void, onRetry?: () => void): UiNode {
	const detail = answerDetail(question);
	const failed = question.delivery === "failed" || question.delivery === "unconfirmed";
	const answered = detail.items.filter(item => item.values.length).length;
	const summary = question.answer
		? detail.items.map(item => item.values.join(", ") || "—").join(" · ")
		: question.reason ? clean(question.reason) : undefined;
	// The host's framed tool card owns padding, folding and the status chip; impersonating the pending
	// form's roles inherited insets that assume a trailing actions row and left the bottom edge cramped.
	return questionBlock({
		role: "async-ask.answered", title: clean(question.title),
		...(!open && summary ? { target: summary } : {}),
		note: question.status === "answered" ? `${answered} of ${detail.items.length} answered · ${questionState(question)}` : questionState(question),
		status: failed ? "error" : question.status === "withdrawn" ? "cancelled" : "done",
		collapsed: !open,
	}, [
		...(question.reason ? [new UiNode("text", { role: "omp.ask.text", wrap: "word", spans: [{ s: "muted", t: clean(question.reason) }] })] : []),
		...detail.intro.map(text => new UiNode("text", { role: "omp.ask.text", wrap: "word", spans: [{ s: "muted", t: text }] })),
		...(question.answer ? detail.items.map(answerFold) : []),
		...(failed && onRetry ? [new UiNode("button", { text: "Review resend…", actions: { click: "retry" }, onAction: onRetry })] : []),
	], question.id, collapsed => onToggle(!collapsed));
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
