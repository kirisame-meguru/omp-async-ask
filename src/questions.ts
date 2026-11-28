/**
 * The structured question schema the model writes; compiled to the native form markup the inbox renders.
 * The journal keeps the compiled form, so restored sessions and answer messages stay unchanged.
 */

export type QuestionKind = "single" | "multi" | "text" | "longtext" | "number";

export interface QuestionOption {
	value: string;
	label?: string;
	detail?: string;
}

export interface QuestionSpec {
	id: string;
	prompt: string;
	kind?: QuestionKind;
	options?: QuestionOption[];
	recommended?: string | number | string[];
	required?: boolean;
}

const MAX_QUESTIONS = 12;
const ID = /^[A-Za-z][\w-]{0,63}$/;

/** Arktype definition of one question, shared by the tool schema. */
export const questionSchema = {
	id: "string",
	prompt: "string",
	"kind?": "'single' | 'multi' | 'text' | 'longtext' | 'number'",
	"options?": [{ value: "string", "label?": "string", "detail?": "string" }, "[]"],
	"recommended?": "string | number | string[]",
	"required?": "boolean",
} as const;

function escape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function kindOf(question: QuestionSpec): QuestionKind {
	return question.kind ?? (question.options?.length ? "single" : "text");
}

function validate(questions: readonly QuestionSpec[]): void {
	if (questions.length === 0) throw new Error("At least one question is required.");
	if (questions.length > MAX_QUESTIONS) throw new Error(`At most ${MAX_QUESTIONS} questions fit one request.`);
	const ids = new Set<string>();
	for (const question of questions) {
		if (!ID.test(question.id)) throw new Error(`Question id "${question.id}" must be an identifier (letters, digits, _ or -).`);
		if (ids.has(question.id)) throw new Error(`Question id "${question.id}" is repeated.`);
		ids.add(question.id);
		if (!question.prompt.trim()) throw new Error(`Question "${question.id}" needs a prompt.`);
		const kind = kindOf(question);
		const choice = kind === "single" || kind === "multi";
		const options = question.options ?? [];
		if (!choice && options.length) throw new Error(`Question "${question.id}" has options but kind ${kind}.`);
		if (!choice) {
			if (Array.isArray(question.recommended)) throw new Error(`Question "${question.id}" recommends a list but is not multi.`);
			if (kind === "number" && question.recommended !== undefined && !Number.isFinite(Number(question.recommended)))
				throw new Error(`Question "${question.id}" recommends a non-number.`);
			continue;
		}
		if (options.length < 2) throw new Error(`Question "${question.id}" needs at least two options.`);
		const values = new Set(options.map(option => option.value));
		if (values.size !== options.length || values.has("")) throw new Error(`Question "${question.id}" needs unique, non-empty option values.`);
		const recommended = question.recommended === undefined ? [] : [question.recommended].flat().map(String);
		if (kind === "single" && recommended.length > 1) throw new Error(`Question "${question.id}" recommends several values but is single.`);
		const unknown = recommended.find(value => !values.has(value));
		if (unknown !== undefined) throw new Error(`Question "${question.id}" recommends unknown option "${unknown}".`);
	}
}

function paragraphs(text: string): string {
	return text
		.split(/\n\s*\n/)
		.map(block => block.trim())
		.filter(Boolean)
		.map(block => `<p>${escape(block).replaceAll("\n", "<br>")}</p>`)
		.join("");
}

function compileOne(question: QuestionSpec): string {
	const kind = kindOf(question);
	const name = escape(question.id);
	const prompt = escape(question.prompt.trim());
	const required = question.required ? " required" : "";
	if (kind === "single" || kind === "multi") {
		const type = kind === "single" ? "radio" : "checkbox";
		const chosen = new Set(question.recommended === undefined ? [] : [question.recommended].flat().map(String));
		const options = question.options!.map(option => {
			const label = escape(option.label?.trim() || option.value) + (option.detail?.trim() ? `: ${escape(option.detail.trim())}` : "");
			const checked = chosen.has(option.value) ? " checked" : "";
			return `<label><input type="${type}" name="${name}" value="${escape(option.value)}"${checked}${required}>${label}</label>`;
		});
		return `<fieldset><legend>${prompt}</legend>${options.join("")}</fieldset>`;
	}
	const value = question.recommended === undefined ? "" : escape(String(question.recommended));
	if (kind === "longtext") return `<label>${prompt}<textarea name="${name}"${required}>${value}</textarea></label>`;
	const type = kind === "number" ? "number" : "text";
	const attr = value ? ` value="${value}"` : "";
	return `<label>${prompt}<input type="${type}" name="${name}"${attr}${required}></label>`;
}

/** Validates the questions and renders them, with optional Markdown-ish context, as one form. */
export function compileQuestions(questions: readonly QuestionSpec[], context?: string): string {
	validate(questions);
	return `<form>${context ? paragraphs(context) : ""}${questions.map(compileOne).join("")}</form>`;
}
