import { Text, type Component } from "@oh-my-pi/pi-tui";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-tui/html-form/parse";
import { col, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import type { NativeToolView, RenderResultOptions, ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Question } from "./state";
import { applyQuestionStyles, questionBlock, questionStatus } from "./ui";

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
		return questionBlock(context, {
			role: "async-ask.answer",
			title: "Answer submitted",
			target: this.summary.title,
			status: "done",
			collapsed: !this.expanded,
			preview: "children",
		}, [
			node("section", {}, this.summary.rows.map(answer => row([
				node("icon", { name: "check", tone: "success" }),
				text(answer, { wrap: "word" }),
			], { gap: "sm", align: "baseline", role: "omp.tool.answer" }))),
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
	constructor(readonly open: () => void, readonly receipt: () => Receipt) {}
	render(): string[] {
		const view = this.receipt();
		return [view.status, ...view.rows, ...(!view.error ? ["Open questions: /questions"] : [])];
	}
	describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		const view = this.receipt();
		return col([
			...(view.rows.length ? [node("section", {}, view.rows.map(value => text(value, { wrap: "word" })))] : []),
			row([
				questionStatus(view.status, view.tone, view.icon),
				...(!view.error ? [node("button", {
					role: "omp.btn",
					text: "Open questions",
					icon: "inbox",
					variant: "quiet",
					size: "sm",
					actions: { click: "open" },
				})] : []),
			], { gap: "sm", justify: "between", wrap: true, role: "async-ask.receipt.footer" }),
		], { gap: "sm", role: "async-ask.receipt" });
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "open") this.open();
	}
	invalidate(): void {}
}

interface ToolArgs { op?: string; title?: string; blockedWork?: string }

interface Receipt {
	title: string;
	status: string;
	tone: "muted" | "success" | "warning" | "error";
	icon?: string;
	rows: string[];
	id?: string;
	error?: boolean;
}

function title(args: ToolArgs): string {
	return clean(args.title || (args.op === "list" ? "Question inbox" : args.op === "withdraw" ? "Withdraw question" : "Question"));
}

function receipt(result: ToolRenderResult, args: ToolArgs, current?: Question): Receipt {
	const details = isRecord(result.details) ? result.details : {};
	const heading = typeof details.title === "string" ? clean(details.title) : title(args);
	if (result.isError) return { title: heading, status: "Could not update questions", tone: "error", error: true, rows: result.content.flatMap(part => part.text ? [clean(part.text)] : []) };
	if (Array.isArray(details.questions)) {
		return {
			title: heading, status: `${details.questions.length} questions`,
			tone: Array.isArray(details.errors) && details.errors.length ? "warning" : "muted",
			icon: "inbox",
			rows: [
				...details.questions.filter(isRecord).map(question => `${clean(String(question.title ?? "Question"))} · ${clean(String(question.status ?? "unknown"))}`),
				...(Array.isArray(details.errors) ? details.errors.map(error => clean(String(error))) : []),
			],
		};
	}
	const state = current?.status ?? details.status;
	const delivery = current?.delivery ?? details.delivery;
	const failed = delivery === "failed" || delivery === "unconfirmed";
	const status = state === "withdrawn" ? "Withdrawn"
		: state === "answered" ? (failed ? (delivery === "failed" ? "Answered · send failed" : "Answered · delivery unconfirmed") : "Answered")
		: state === "pending" ? "Awaiting answer" : "Question updated";
	const tone = failed ? "warning" : state === "answered" ? "success" : "muted";
	const context = current?.reason ?? details.reason ?? details.blockedWork ?? args.blockedWork;
	return {
		title: heading, status, tone, icon: state === "withdrawn" ? "x" : undefined,
		rows: typeof context === "string" && context ? [clean(context)] : [],
		id: typeof details.id === "string" ? details.id : undefined,
	};
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
			return { tool: { title: "Ask asynchronously", target: title(args), targetKind: "text" }, inline: false };
		},
		describeResult(result: ToolRenderResult, options: RenderResultOptions, args: ToolArgs = {}): NativeToolView {
			const view = receipt(result, args);
			return {
				tool: { target: view.title, targetKind: "text" },
				inline: false,
				body: [
					new OpenQuestions(
						() => open(view.id),
						() => receipt(result, args, view.id ? lookup?.(view.id) : undefined),
					),
					...(options.expanded ? [node("code", { text: clean(result.content.flatMap(part => part.text ? [part.text] : []).join("\n")), lang: "text" })] : []),
				],
				preview: "children",
			};
		},
	};
}
