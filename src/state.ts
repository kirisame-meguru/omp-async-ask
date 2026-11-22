import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";
import { fieldError, type HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { isRecord, logger } from "@oh-my-pi/pi-utils";

export const EVENT_TYPE = "omp-async-ask:event";
export const ANSWER_TYPE = "omp-async-ask:answer";
export const MAX_PENDING = 32;
export const MAX_FORM_BYTES = 64 * 1024;
const MAX_METADATA = 4096;

export interface CreateQuestion {
	title: string;
	html: string;
	blockedWork: string;
	continueWith?: string[];
	key?: string;
}
export type DeliveryState = "submitted" | "queued" | "recorded" | "unconfirmed";
export interface AnswerNote {
	name: string;
	question: string;
	option: string;
	value: string;
	text: string;
}
export interface SubmittedAnswer {
	id: string;
	data: HtmlFormData;
	notes: AnswerNote[];
}
export interface Question extends CreateQuestion {
	id: string;
	sessionId: string;
	toolCallId: string;
	createdAt: number;
	status: "pending" | "answered" | "withdrawn";
	reason?: string;
	answer?: SubmittedAnswer;
	delivery?: DeliveryState;
}
export type QuestionEvent = { version: 1; sessionId: string } & (
	| { kind: "created"; question: Question }
	| { kind: "withdrawn"; requestId: string; reason: string }
	| { kind: "submitted"; requestId: string; answer: SubmittedAnswer }
);

function nonempty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
function validInput(value: unknown): value is CreateQuestion {
	return (
		isRecord(value) &&
		nonempty(value.title) &&
		nonempty(value.html) &&
		nonempty(value.blockedWork) &&
		(value.key === undefined || nonempty(value.key)) &&
		(value.continueWith === undefined || (Array.isArray(value.continueWith) && value.continueWith.every(nonempty)))
	);
}
function validateInput(input: CreateQuestion): void {
	if (!validInput(input)) throw new Error("A title, form and description of blocked work are required.");
	if (Buffer.byteLength(input.html, "utf8") > MAX_FORM_BYTES) throw new Error("The form exceeds 64 KiB.");
	if (
		[input.title, input.blockedWork, input.key ?? "", ...(input.continueWith ?? [])].join("\n").length > MAX_METADATA
	) {
		throw new Error("Question metadata exceeds 4096 characters.");
	}
	if (!parseHtmlForm(input.html).fields.some(field => field.name)) throw new Error("The form needs a named control.");
}
function validData(value: unknown): value is HtmlFormData {
	return (
		isRecord(value) &&
		Object.values(value).every(
			item =>
				typeof item === "string" ||
				(typeof item === "number" && Number.isFinite(item)) ||
				(Array.isArray(item) && item.every(part => typeof part === "string")),
		)
	);
}
function validNote(value: unknown): value is AnswerNote {
	return (
		isRecord(value) &&
		[value.name, value.question, value.option, value.value, value.text].every(item => typeof item === "string") &&
		value.images === undefined
	);
}
function validAnswer(value: unknown): value is SubmittedAnswer {
	return (
		isRecord(value) &&
		nonempty(value.id) &&
		validData(value.data) &&
		Array.isArray(value.notes) &&
		value.notes.every(validNote)
	);
}
function validateSubmission(question: Question, data: HtmlFormData, notes: AnswerNote[]): void {
	if (!validData(data) || !notes.every(validNote)) throw new Error("Invalid answer data or unsupported attachments.");
	const form = parseHtmlForm(question.html);
	const names = new Set([...form.fields.flatMap(field => (field.name ? [field.name] : [])), ...form.hidden.keys()]);
	if (Object.keys(data).some(name => !names.has(name))) throw new Error("Answer contains an unknown field.");
	for (const field of form.fields) {
		if (!field.name) continue;
		const error = fieldError(field, data[field.name]);
		if (error) throw new Error(`${field.name}: ${error}`);
	}
}
function validEvent(value: unknown): value is QuestionEvent {
	if (!isRecord(value) || value.version !== 1 || !nonempty(value.sessionId)) return false;
	if (value.kind === "created") {
		const question = value.question;
		return (
			validInput(question) &&
			isRecord(question) &&
			nonempty(question.id) &&
			question.sessionId === value.sessionId &&
			nonempty(question.toolCallId) &&
			typeof question.createdAt === "number" &&
			Number.isFinite(question.createdAt) &&
			question.status === "pending" &&
			question.answer === undefined &&
			question.delivery === undefined
		);
	}
	if (!nonempty(value.requestId)) return false;
	if (value.kind === "withdrawn") return nonempty(value.reason);
	return value.kind === "submitted" && validAnswer(value.answer);
}
function sameInput(left: CreateQuestion, right: CreateQuestion): boolean {
	return (
		left.title === right.title &&
		left.html === right.html &&
		left.blockedWork === right.blockedWork &&
		left.key === right.key &&
		JSON.stringify(left.continueWith ?? []) === JSON.stringify(right.continueWith ?? [])
	);
}

/** The active branch's journal is authoritative; delivery states are observations, not acknowledgements. */
export class QuestionStore {
	#questions = new Map<string, Question>();
	#listeners = new Set<() => void>();
	#snapshot: readonly Question[] | undefined;
	#errors: string[] = [];
	constructor(
		readonly sessionId: string,
		readonly append: (event: QuestionEvent) => void,
	) {}
	get errors(): readonly string[] {
		return this.#errors;
	}
	get(id: string): Question | undefined {
		return this.#questions.get(id);
	}
	list(): readonly Question[] {
		return (this.#snapshot ??= [...this.#questions.values()]);
	}
	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}
	#changed(): void {
		this.#snapshot = undefined;
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.error("Async Ask observer failed", { error: String(error) });
			}
		}
	}
	#healthy(): void {
		if (this.#errors.length)
			throw new Error(
				"Inbox history could not be restored safely. Start a new conversation or inspect the reported records.",
			);
	}
	#require(id: string): Question {
		this.#healthy();
		const question = this.get(id);
		if (!question) throw new Error("Question not found in this conversation.");
		return question;
	}
	#commit(event: QuestionEvent): void {
		this.append(structuredClone(event));
		this.#apply(event);
		this.#changed();
	}
	#apply(event: QuestionEvent): void {
		if (event.kind === "created") {
			validateInput(event.question);
			if (this.#questions.has(event.question.id)) throw new Error("Duplicate question identity.");
			this.#questions.set(event.question.id, structuredClone(event.question));
			return;
		}
		const question = this.#questions.get(event.requestId);
		if (!question) throw new Error("Question event has no creation record.");
		if (question.status !== "pending") throw new Error("Question event follows a terminal state.");
		this.#questions.set(
			question.id,
			event.kind === "withdrawn"
				? { ...question, status: "withdrawn", reason: event.reason }
				: { ...question, status: "answered", answer: structuredClone(event.answer), delivery: "submitted" },
		);
	}
	create(input: CreateQuestion, toolCallId: string): Question {
		this.#healthy();
		validateInput(input);
		if (!nonempty(toolCallId)) throw new Error("A tool-call identity is required.");
		for (const question of this.list()) {
			if (question.toolCallId === toolCallId) {
				if (!sameInput(question, input)) throw new Error("Tool-call identity was reused with different content.");
				return question;
			}
			if (input.key && question.key === input.key && question.status !== "withdrawn") {
				if (!sameInput(question, input))
					throw new Error("This key already identifies a different question; withdraw it before replacing it.");
				return question;
			}
		}
		if (this.list().filter(question => question.status === "pending").length >= MAX_PENDING) {
			throw new Error("The inbox already has 32 pending questions; resolve or withdraw one first.");
		}
		const question: Question = {
			...input,
			id: crypto.randomUUID(),
			sessionId: this.sessionId,
			toolCallId,
			createdAt: Date.now(),
			status: "pending",
		};
		this.#commit({ version: 1, sessionId: this.sessionId, kind: "created", question });
		return this.get(question.id)!;
	}
	withdraw(id: string, reason: string): Question {
		const question = this.#require(id);
		if (question.status === "withdrawn") return question;
		if (question.status === "answered") throw new Error("An answered question cannot be withdrawn.");
		if (!nonempty(reason)) throw new Error("A withdrawal reason is required.");
		this.#commit({ version: 1, sessionId: this.sessionId, kind: "withdrawn", requestId: id, reason });
		return this.get(id)!;
	}
	submit(id: string, data: HtmlFormData, notes: AnswerNote[]): Question {
		const question = this.#require(id);
		if (question.status !== "pending") throw new Error("This question is no longer pending.");
		validateSubmission(question, data, notes);
		this.#commit({
			version: 1,
			sessionId: this.sessionId,
			kind: "submitted",
			requestId: id,
			answer: { id: crypto.randomUUID(), data, notes },
		});
		return this.get(id)!;
	}
	setDelivery(id: string, delivery: DeliveryState): void {
		const question = this.get(id);
		if (!question?.answer || question.delivery === delivery) return;
		this.#questions.set(id, { ...question, delivery });
		this.#changed();
	}
	observe(message: AgentMessage): boolean {
		if (message.role !== "custom" || message.customType !== ANSWER_TYPE || !isRecord(message.details)) return false;
		const { sessionId, requestId, answerId } = message.details;
		if (sessionId !== this.sessionId || typeof requestId !== "string") return false;
		const question = this.get(requestId);
		if (!question?.answer || question.answer.id !== answerId) return false;
		this.setDelivery(requestId, "recorded");
		return true;
	}
	restore(entries: readonly SessionEntry[]): void {
		this.#questions.clear();
		this.#errors = [];
		let start = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			if (entries[i]!.type === "reset_boundary") {
				start = i + 1;
				break;
			}
		}
		for (let i = start; i < entries.length; i++) {
			const entry = entries[i]!;
			if (entry.type === "custom" && entry.customType === EVENT_TYPE) {
				if (
					isRecord(entry.data) &&
					typeof entry.data.sessionId === "string" &&
					entry.data.sessionId !== this.sessionId
				)
					continue;
				try {
					if (!validEvent(entry.data)) throw new Error("Unsupported or malformed journal event.");
					if (entry.data.kind === "submitted") {
						const question = this.get(entry.data.requestId);
						if (question) validateSubmission(question, entry.data.answer.data, entry.data.answer.notes);
					}
					this.#apply(entry.data);
					if (entry.data.kind === "submitted") {
						const question = this.#questions.get(entry.data.requestId)!;
						this.#questions.set(question.id, { ...question, delivery: "unconfirmed" });
					}
				} catch (error) {
					this.#errors.push(`Record ${entry.id}: ${String(error)}`);
				}
			} else if (entry.type === "message") this.observe(entry.message);
		}
		this.#changed();
	}
}
