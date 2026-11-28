import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { parseHtmlForm, spansText } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { onCleanup, signal, UiNode } from "@oh-my-pi/pi-tui";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Question } from "./state";
import { questionBlock, questionStatus } from "./ui";

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

export function AnswerCard(summary: AnswerPresentation, expanded: boolean): UiNode {
	const open = signal(expanded);
	return new UiNode("col", { children: () => questionBlock({
		role: "async-ask.answer", title: "Answer submitted", target: summary.title,
		status: "done", collapsed: !open(), preview: { lines: 8 },
	}, [
		new UiNode("section", { children: summary.rows.map(answer => questionStatus(answer, "success")) }),
	], undefined, collapsed => open.set(!collapsed)) });
}

type ToolRenderResult = Parameters<NonNullable<ToolDefinition["renderResult"]>>[0] & { isError?: boolean };
type RenderResultOptions = Parameters<NonNullable<ToolDefinition["renderResult"]>>[1];

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
	if (result.isError) return { title: heading, status: "Could not update questions", tone: "error", error: true, rows: result.content.flatMap(part => part.type === "text" ? [clean(part.text)] : []) };
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
	const context = current?.reason ?? details.reason;
	return {
		title: heading, status, tone, icon: state === "withdrawn" ? "x" : undefined,
		rows: typeof context === "string" && context ? [clean(context)] : [],
		id: typeof details.id === "string" ? details.id : undefined,
	};
}

export function questionRenderers(
	open: (id?: string) => void,
	lookup?: (id: string) => Question | undefined,
	subscribe?: (listener: () => void) => (() => void) | undefined,
) {
	return {
		renderCall() {
			// The host already labels the call and may compose this hook twice for results.
			return undefined;
		},
		renderResult(result: ToolRenderResult, _options: RenderResultOptions, _theme: unknown, args: ToolArgs = {}) {
			const revision = signal(0);
			const off = subscribe?.(() => revision.update(n => n + 1));
			if (off) onCleanup(off);
			const initial = receipt(result, args);
			return new UiNode("col", { role: "async-ask.receipt", gap: "sm", children: () => {
				revision();
				const view = receipt(result, args, initial.id ? lookup?.(initial.id) : undefined);
				return [
					new UiNode("text", { role: "omp.ask.fold.answer", text: view.title, wrap: "word" }),
					...view.rows.map(value => new UiNode("text", { role: "omp.ask.fold.answer", text: value, wrap: "word" })),
					new UiNode("row", { gap: "sm", justify: "between", children: [
						questionStatus(view.status, view.tone, view.icon),
						...(!view.error ? [new UiNode("button", {
							role: "omp.btn", text: "Open questions", icon: "inbox", actions: { click: "open" },
							onAction: () => open(view.id),
						})] : []),
					] }),
				];
			} });
		},
	};
}
