import { Text, type Component } from "@oh-my-pi/pi-tui";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { card, col, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { NativeToolView, RenderResultOptions, ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Question } from "./state";
import { applyQuestionStyles } from "./ui";

function clean(value: string): string {
	return sanitizeText(value).replaceAll("\t", "    ");
}

export interface AnswerPresentation {
	title: string;
	rows: string[];
}

/** Derive display text from the submitted values, never from recommended defaults. */
export function summarizeAnswer(question: Question): AnswerPresentation {
	const rows: string[] = [];
	const answer = question.answer;
	if (answer) {
		const form = parseHtmlForm(question.html);
		for (const section of form.sections) {
			for (const block of section.blocks) {
				if (block.kind !== "field") continue;
				const field = block.field;
				const value = answer.data[field.name];
				if (value === undefined || value === "" || (Array.isArray(value) && !value.length)) continue;
				const values = Array.isArray(value) ? value : [String(value)];
				const labels = values.map(value => {
					const option = field.kind === "choice" ? field.options.find(option => option.value === value) : undefined;
					return option ? spansText(option.label) || value : value;
				});
				const label = spansText(field.label) || spansText(section.title) || field.name;
				rows.push(clean(`${label}: ${labels.join(", ")}`));
			}
		}
		for (const note of answer.notes) {
			if (note.text) rows.push(clean(`${note.question || note.name} — ${note.option}: ${note.text}`));
		}
	}
	return { title: clean(question.title), rows: rows.length ? rows : ["No values provided"] };
}

export function savedAnswerPresentation(details: unknown): AnswerPresentation | undefined {
	if (!isRecord(details) || !isRecord(details.presentation)) return undefined;
	const { title, rows } = details.presentation;
	if (typeof title !== "string" || !Array.isArray(rows) || !rows.every(row => typeof row === "string")) return undefined;
	return { title: clean(title), rows: rows.map(clean) };
}

export class AnswerCard implements Component {
	#styled = false;
	constructor(readonly summary: AnswerPresentation, private expanded: boolean, readonly raw: string) {}
	render(width: number): readonly string[] {
		return new Text([
			`Answer submitted · ${this.summary.title}`, ...this.summary.rows,
			...(this.expanded ? [clean(this.raw)] : []),
		].join("\n"), 0, 0).render(width);
	}
	describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		return card({
			role: "async-ask.answer",
			head: [span("Answer submitted", "success strong"), span(` · ${this.summary.title}`)],
			collapsible: true,
			collapsed: !this.expanded,
			preview: { lines: this.summary.rows.length },
		}, [
			...this.summary.rows.map(row => text(row)),
			...(this.expanded ? [node("code", { text: clean(this.raw), lang: "text" })] : []),
		]);
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "toggle" && event.key === "") this.expanded = !event.collapsed;
	}
	invalidate(): void {}
}

/** A component boundary keeps receipt state live and routes its button independently of the tool card. */
class OpenQuestions implements Component {
	#styled = false;
	constructor(readonly open: () => void, readonly receipt?: () => { status: string; rows: string[] }) {}
	render(): string[] {
		const view = this.receipt?.();
		return [...(view ? [view.status, ...view.rows] : []), "Open questions: /questions"];
	}
	describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		const button = node("button", { text: "Open questions", icon: "inbox", actions: { click: "open" } });
		const view = this.receipt?.();
		return view
			? col([col([text(view.status), ...view.rows.map(row => text(row))]), button], { gap: "sm", role: "async-ask.receipt" })
			: button;
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "open") this.open();
	}
	invalidate(): void {}
}

interface ToolArgs { op?: string; title?: string; blockedWork?: string }

function title(args: ToolArgs): string {
	return clean(args.title || (args.op === "list" ? "Question inbox" : args.op === "withdraw" ? "Withdraw question" : "Question"));
}

function receipt(result: ToolRenderResult, args: ToolArgs, current?: Question): { title: string; status: string; rows: string[]; id?: string } {
	const details = isRecord(result.details) ? result.details : {};
	const heading = typeof details.title === "string" ? clean(details.title) : title(args);
	if (result.isError) return { title: heading, status: "Could not update questions", rows: result.content.flatMap(part => part.text ? [clean(part.text)] : []) };
	if (Array.isArray(details.questions)) {
		return {
			title: heading, status: `${details.questions.length} questions`,
			rows: [
				...details.questions.filter(isRecord).map(question => `${clean(String(question.title ?? "Question"))} · ${clean(String(question.status ?? "unknown"))}`),
				...(Array.isArray(details.errors) ? details.errors.map(error => clean(String(error))) : []),
			],
		};
	}
	const state = current?.status ?? details.status;
	const status = state === "withdrawn" ? "Withdrawn"
		: state === "answered" ? (current?.delivery === "failed" ? "Answered · send failed" : "Answered")
		: state === "pending" ? "Awaiting answer" : "Question updated";
	const context = current?.reason ?? details.reason ?? details.blockedWork ?? args.blockedWork;
	return { title: heading, status, rows: typeof context === "string" && context ? [clean(context)] : [], id: typeof details.id === "string" ? details.id : undefined };
}

export function questionRenderers(open: (id?: string) => void, lookup?: (id: string) => Question | undefined) {
	return {
		renderCall(args: ToolArgs) { return new Text(`Ask asynchronously · ${title(args)}`, 0, 0); },
		renderResult(result: ToolRenderResult, options: RenderResultOptions, _theme: unknown, args: ToolArgs = {}) {
			const view = receipt(result, args);
			return new Text([view.status, ...view.rows, ...(!result.isError ? ["/questions"] : []),
				...(options.expanded ? result.content.flatMap(part => part.text ? [clean(part.text)] : []) : []),
			].join("\n"), 0, 0);
		},
		describeCall(args: ToolArgs): NativeToolView {
			return { tool: { title: "Ask asynchronously", target: title(args) } };
		},
		describeResult(result: ToolRenderResult, options: RenderResultOptions, args: ToolArgs = {}): NativeToolView {
			const view = receipt(result, args);
			return {
				tool: { target: view.title, ...(!view.id ? { note: view.status } : {}) },
				body: [
					...(view.id && !result.isError
						? [new OpenQuestions(() => open(view.id), () => receipt(result, args, lookup?.(view.id!)))]
						: [...view.rows.map(row => text(row)), ...(!result.isError ? [new OpenQuestions(() => open())] : [])]),
					...(options.expanded ? [node("code", { text: clean(result.content.flatMap(part => part.text ? [part.text] : []).join("\n")), lang: "text" })] : []),
				],
				preview: "children",
			};
		},
	};
}
