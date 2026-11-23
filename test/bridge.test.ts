import { expect, test } from "bun:test";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { createQuestionSource, type AsyncQuestion } from "../src/bridge";
import { AnswerDelivery } from "../src/delivery";
import { EVENT_TYPE, QuestionStore } from "../src/state";
import { input, journal, recorded } from "./helpers";

function fixture(send?: (message: CustomMessagePayload) => void, persist = journal()) {
	const store = new QuestionStore("session", persist.append);
	const sent: CustomMessagePayload[] = [];
	let current = true;
	const delivery = new AnswerDelivery(store, {
		sessionId: () => current ? "session" : "successor",
		isIdle: () => false,
		entries: () => persist.entries,
		send(message) { sent.push(message); send?.(message); },
	});
	const source = createQuestionSource(store, delivery, () => current);
	let questions: readonly AsyncQuestion[] = [];
	source.subscribe(next => { questions = next; });
	return { store, delivery, source, sent, persist, questions: () => questions, replace: () => { current = false; } };
}

test("pending snapshots exist without an inbox UI and confirmed answers use one canonical dispatch", () => {
	const f = fixture();
	try {
		const q = f.store.create(input, "tool");
		const cap = f.questions()[0]!;
		expect(cap.id).toBe(q.id);
		const result = cap.submitConfirmed({ target: "staging" });
		expect(result).toEqual({ kind: "accepted", answerId: f.store.get(q.id)!.answer!.id, delivery: "queued" });
		expect(f.questions()).toEqual([]);
		expect(f.sent).toHaveLength(1);
		expect(f.sent[0]).toMatchObject({ attribution: "user" });
		expect(cap.submitConfirmed({ target: "production" })).toEqual({ kind: "stale" });
		expect(f.sent).toHaveLength(1);
	} finally { f.source.close(); }
});

test("desktop victory, withdrawal and owner replacement revoke retained phone capabilities", () => {
	for (const end of ["desktop", "withdraw", "replace", "dispose"] as const) {
		const f = fixture();
		try {
			const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
			if (end === "desktop") f.delivery.submit(q.id, { target: "desktop" }, []);
			else if (end === "withdraw") f.store.withdraw(q.id, "No longer needed");
			else if (end === "replace") f.replace();
			else f.source.close();
			expect(cap.submitConfirmed({ target: "phone" })).toEqual({ kind: "stale" });
			expect(f.sent).toHaveLength(end === "desktop" ? 1 : 0);
			if (end === "desktop") expect(f.store.get(q.id)!.answer!.data).toEqual({ target: "desktop" });
		} finally { f.source.close(); }
	}
});

test("a saved dispatch failure is terminal and never automatically resent", () => {
	const f = fixture(() => { throw new Error("transport failed"); });
	try {
		const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "saved", answerId: f.store.get(q.id)!.answer!.id, delivery: "failed" });
		expect(f.questions()).toEqual([]);
		f.delivery.settle();
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "stale" });
		expect(f.sent).toHaveLength(1);
	} finally { f.source.close(); }
});

test("a matching synchronous receipt remains recorded even when the sender subsequently throws", () => {
	const f = fixture(message => {
		if (typeof message === "string") throw new Error("Expected a structured answer");
		const details = message.details as { requestId: string; answerId: string };
		f.delivery.observe(recorded("session", details.requestId, details.answerId));
		throw new Error("late send error");
	});
	try {
		const q = f.store.create(input, "tool");
		expect(f.questions()[0]!.submitConfirmed({ target: "staging" })).toEqual({ kind: "accepted", answerId: f.store.get(q.id)!.answer!.id, delivery: "recorded" });
		expect(f.sent).toHaveLength(1);
	} finally { f.source.close(); }
});

test("source retirement during its own submission does not suppress authorized same-session dispatch", () => {
	const f = fixture();
	try {
		const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
		f.source.subscribe(next => { if (!next.length) f.source.close(); });
		expect(cap.submitConfirmed({ target: "staging" }).kind).toBe("accepted");
		expect(f.store.get(q.id)!.status).toBe("answered");
		expect(f.sent).toHaveLength(1);
	} finally { f.source.close(); }
});

test("owner replacement after saving cannot dispatch into the successor conversation", () => {
	const f = fixture();
	try {
		const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
		f.store.subscribe(() => { if (f.store.get(q.id)?.status === "answered") f.replace(); });
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "saved", answerId: f.store.get(q.id)!.answer!.id, delivery: "submitted" });
		expect(f.sent).toEqual([]);
	} finally { f.source.close(); }
});

test("canonical validation rejects missing required values without creating an answer", () => {
	const f = fixture();
	try {
		const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
		expect(cap.submitConfirmed({})).toEqual({ kind: "invalid" });
		expect(f.store.get(q.id)!.status).toBe("pending");
		expect(f.questions()).toEqual([]);
		expect(f.sent).toEqual([]);
		expect(cap.submitConfirmed({ target: "retry" })).toEqual({ kind: "stale" });
	} finally { f.source.close(); }
});

test("persistence failure is uncertain, never success or an automatic retry", () => {
	const log = journal();
	let deny = false;
	const f = fixture(undefined, { entries: log.entries, append(event) { if (deny) throw new Error("disk failed"); log.append(event); } });
	try {
		const q = f.store.create(input, "tool");
		const cap = f.questions()[0]!;
		deny = true;
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "uncertain" });
		expect(f.store.get(q.id)!.status).toBe("pending");
		expect(f.questions()).toEqual([]);
		deny = false;
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "stale" });
		expect(f.sent).toEqual([]);
	} finally { f.source.close(); }
});

test("restoration exposes only pending questions with original creation time and no answer resends", () => {
	const f = fixture();
	const pending = f.store.create(input, "pending");
	const answered = f.store.create({ ...input, title: "Answered" }, "answered");
	const withdrawn = f.store.create({ ...input, title: "Withdrawn" }, "withdrawn");
	f.delivery.submit(answered.id, { target: "staging" }, []);
	f.store.withdraw(withdrawn.id, "obsolete");
	f.source.close();
	const restored = fixture(undefined, f.persist);
	try {
		restored.store.restore(f.persist.entries);
		expect(restored.questions().map(q => [q.id, q.createdAt])).toEqual([[pending.id, pending.createdAt]]);
		expect(restored.sent).toEqual([]);
	} finally { restored.source.close(); }
});

test("corrupt restored history removes mobile offers instead of exposing a partially replayed question", () => {
	const f = fixture();
	try {
		const q = f.store.create(input, "tool"), cap = f.questions()[0]!;
		f.persist.entries.push({
			type: "custom", id: "bad", parentId: null, timestamp: new Date().toISOString(),
			customType: EVENT_TYPE, data: { version: 999, kind: "submitted", sessionId: "session" },
		});
		f.store.restore(f.persist.entries);
		expect(f.store.get(q.id)!.status).toBe("pending");
		expect(f.questions()).toEqual([]);
		expect(cap.submitConfirmed({ target: "staging" })).toEqual({ kind: "stale" });
		expect(f.sent).toEqual([]);
	} finally { f.source.close(); }
});
