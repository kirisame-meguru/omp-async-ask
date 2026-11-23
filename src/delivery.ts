import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { CustomMessagePayload, SessionEntry } from "@oh-my-pi/pi-coding-agent";
import type { HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { prompt } from "@oh-my-pi/pi-utils";
import answerTemplate from "./prompts/answer.md" with { type: "text" };
import { summarizeAnswer } from "./presentation";
import { ANSWER_TYPE, type AnswerNote, type DeliveryState, type Question, type QuestionStore } from "./state";

export interface DeliveryPort {
	sessionId(): string;
	isIdle(): boolean;
	hasPendingMessages?(): boolean;
	entries(): readonly SessionEntry[];
	send(message: CustomMessagePayload, options: { deliverAs: "aside" }): void;
}

export interface SubmissionReceipt {
	answerId: string;
	delivery: DeliveryState;
	failure?: { error: unknown };
}

/** Explicit user actions dispatch answers. Lifecycle observations never start turns. */
export class AnswerDelivery {
	#disposed = false;
	constructor(
		readonly store: QuestionStore,
		readonly port: DeliveryPort,
	) {}
	#current(): boolean {
		return !this.#disposed && this.port.sessionId() === this.store.sessionId;
	}
	#assertCurrent(): void {
		if (!this.#current()) throw new Error("This inbox belongs to an inactive session. Reopen /questions.");
	}
	submit(id: string, data: HtmlFormData, notes: AnswerNote[]): void {
		const receipt = this.submitWithReceipt(id, data, notes);
		if (receipt.failure) throw receipt.failure.error;
	}
	submitWithReceipt(id: string, data: HtmlFormData, notes: AnswerNote[]): SubmissionReceipt {
		this.#assertCurrent();
		const question = this.store.submit(id, data, notes);
		const answerId = question.answer!.id;
		let failure: SubmissionReceipt["failure"];
		try {
			this.#send(question);
		} catch (error) {
			failure = { error };
		}
		const observed = this.store.get(id);
		const delivery = observed?.answer?.id === answerId ? observed.delivery ?? "submitted" : "unconfirmed";
		return { answerId, delivery, ...(failure ? { failure } : {}) };
	}
	#reconcile(): void {
		for (const entry of this.port.entries()) this.store.observeEntry(entry);
	}
	retry(id: string): void {
		this.#assertCurrent();
		this.#reconcile();
		const question = this.store.get(id);
		if (!question?.answer) throw new Error("There is no submitted answer to retry.");
		if (question.delivery === "recorded") return;
		if (question.delivery === "queued") throw new Error("The answer is already queued; wait for delivery to settle.");
		this.#send(question);
	}
	#send(question: Question): void {
		this.#assertCurrent();
		const answer = question.answer!;
		this.store.setDelivery(question.id, "queued");
		try {
			// A store observer can close the UI or replace its owner; recheck just before dispatch.
			this.#assertCurrent();
			this.port.send(
				{
					customType: ANSWER_TYPE,
					display: true,
					attribution: "user",
					details: {
						sessionId: this.store.sessionId, requestId: question.id, answerId: answer.id,
						presentation: summarizeAnswer(question),
					},
					content: prompt.render(answerTemplate, {
						requestId: question.id,
						answerId: answer.id,
						title: question.title,
						blockedWork: question.blockedWork,
						html: question.html,
						data: JSON.stringify(answer.data, null, 2),
						notes: JSON.stringify(answer.notes, null, 2),
					}),
				},
				{ deliverAs: "aside" },
			);
		} catch (error) {
			if (this.store.get(question.id)?.delivery !== "recorded") this.store.setDelivery(question.id, "failed");
			throw error;
		}
	}
	observe(message: AgentMessage): void {
		if (this.#current()) this.store.observe(message);
	}
	settle(): void {
		if (!this.#current()) return;
		this.#reconcile();
		if (!this.port.isIdle() || this.port.hasPendingMessages?.()) return;
		for (const question of this.store.list()) {
			if (question.delivery === "queued") this.store.setDelivery(question.id, "unconfirmed");
		}
	}
	dispose(): void {
		this.#disposed = true;
	}
}
