import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { HtmlFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { AnswerDelivery } from "./delivery";
import { InvalidAnswerError, type AnswerNote, type DeliveryState, type Question, type QuestionStore } from "./state";

export const AVAILABLE = "omp-async-ask:available:v1";
export const CONNECT = "omp-async-ask:connect:v1";
export type QuestionSubmission =
	| { kind: "accepted" | "saved"; answerId: string; delivery: DeliveryState }
	| { kind: "stale" | "invalid" | "uncertain" };
export interface AsyncQuestion {
	readonly id: string;
	readonly requestId: string;
	readonly toolCallId: string;
	readonly title: string;
	readonly html: string;
	readonly blockedWork: string;
	readonly createdAt: number;
	readonly supportsOptionNotes?: boolean;
	submitConfirmed(values: HtmlFormData, notes?: AnswerNote[]): QuestionSubmission;
	withdraw(reason: string): { kind: "withdrawn" | "stale" };
}
export interface QuestionSource {
	readonly version: 1;
	readonly sessionId: string;
	readonly signal: AbortSignal;
	subscribe(listener: (questions: readonly AsyncQuestion[]) => void): () => void;
}
export interface OwnedQuestionSource extends QuestionSource { close(): void }
type Events = Pick<ExtensionAPI["events"], "on" | "emit">;
interface CachedOffer { question: Question; offer: AsyncQuestion; attempted: boolean }

/** Discovery contains no question data; only the requesting trusted extension receives the source. */
export function serveQuestionSources(events: Events, current: () => QuestionSource | undefined): () => void {
	return events.on(CONNECT, request => {
		if (!isRecord(request) || request.version !== 1 || typeof request.accept !== "function") return;
		const source = current();
		if (!source || source.signal.aborted || source.sessionId !== request.sessionId) return;
		try { request.accept(source); }
		catch { logger.warn("Async Ask bridge attachment failed"); }
	});
}

export function createQuestionSource(store: QuestionStore, delivery: AnswerDelivery, current: () => boolean, onWithdraw?: (question: Question, reason: string) => void): OwnedQuestionSource {
	const life = new AbortController();
	const listeners = new Set<(questions: readonly AsyncQuestion[]) => void>();
	const offers = new Map<string, CachedOffer>();
	let snapshot: readonly AsyncQuestion[] = Object.freeze([]);
	const active = () => !life.signal.aborted && current();
	function notify(listener: (questions: readonly AsyncQuestion[]) => void) {
		try { listener(snapshot); }
		catch { logger.warn("Async Ask bridge observer failed"); }
	}
	function offer(question: Question): CachedOffer {
		const cached: CachedOffer = { question, attempted: false, offer: Object.freeze({
			id: question.id, requestId: crypto.randomUUID(), toolCallId: question.toolCallId, title: question.title,
			html: question.html, blockedWork: question.blockedWork, createdAt: question.createdAt,
			supportsOptionNotes: true,
			withdraw(reason: string): { kind: "withdrawn" | "stale" } {
				if (!active() || cached.attempted || store.errors.length || store.get(question.id) !== question || question.status !== "pending") return { kind: "stale" };
				if (!reason.trim() || Buffer.byteLength(reason) > 16384) throw Error("Invalid withdrawal reason");
				try {
					store.withdraw(question.id, reason);
					onWithdraw?.(question, reason);
					return { kind: "withdrawn" };
				} finally {
					if (active()) refresh();
				}
			},
			submitConfirmed(values: HtmlFormData, notes: AnswerNote[] = []): QuestionSubmission {
				if (!active() || cached.attempted || store.errors.length || store.get(question.id) !== question || question.status !== "pending") return { kind: "stale" };
				cached.attempted = true;
				try {
					const receipt = delivery.submitWithReceipt(question.id, values, notes);
					const accepted = receipt.delivery === "recorded" || (receipt.delivery === "queued" && !receipt.failure);
					return { kind: accepted ? "accepted" : "saved", answerId: receipt.answerId, delivery: receipt.delivery };
				} catch (error) {
					return { kind: error instanceof InvalidAnswerError ? "invalid" : "uncertain" };
				} finally {
					if (active()) refresh();
				}
			},
		}) };
		return cached;
	}
	function refresh() {
		const pending = active() && !store.errors.length ? store.list().filter(question => question.status === "pending") : [];
		const next: AsyncQuestion[] = [];
		const retained = new Set<string>();
		for (const question of pending) {
			retained.add(question.id);
			let cached = offers.get(question.id);
			if (!cached || cached.question !== question) {
				cached = offer(question);
				offers.set(question.id, cached);
			}
			if (!cached.attempted) next.push(cached.offer);
		}
		for (const id of offers.keys()) if (!retained.has(id)) offers.delete(id);
		snapshot = Object.freeze(next);
		for (const listener of [...listeners]) {
			if (life.signal.aborted) break;
			if (listeners.has(listener)) notify(listener);
		}
	}
	const unsubscribe = store.subscribe(refresh);
	refresh();
	return Object.freeze({
		version: 1 as const, sessionId: store.sessionId, signal: life.signal,
		subscribe(listener: (questions: readonly AsyncQuestion[]) => void) {
			if (!active()) return () => {};
			listeners.add(listener);
			notify(listener);
			return () => { listeners.delete(listener); };
		},
		close() {
			if (life.signal.aborted) return;
			unsubscribe();
			listeners.clear(); offers.clear(); snapshot = Object.freeze([]);
			life.abort();
		},
	});
}
