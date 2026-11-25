import { describe, expect, test } from "bun:test";
import type { HtmlFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { EVENT_TYPE, MAX_PENDING, QuestionStore } from "../src/state";
import { input, journal, recorded, recordedEntry } from "./helpers";

describe("question journal", () => {
	test("retrying creation returns the existing request's current state, not another pending question", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		const question = store.create(input, "call-1");
		store.withdraw(question.id, "Found the documented target");
		expect(store.create(input, "call-1").status).toBe("withdrawn");
		expect(store.list().map(item => item.id)).toEqual([question.id]);
		expect(log.entries).toHaveLength(2);
	});

	test("logical retries deduplicate but cannot silently replace an open form", () => {
		const store = new QuestionStore("a", journal().append);
		const first = store.create({ ...input, key: "deploy" }, "one");
		expect(store.create({ ...input, key: "deploy" }, "two").id).toBe(first.id);
		expect(() => store.create({ ...input, key: "deploy", title: "Different" }, "three")).toThrow("key");
		store.withdraw(first.id, "Changed the question");
		expect(store.create({ ...input, key: "deploy", title: "Different" }, "four").id).not.toBe(first.id);
	});

	test("invalid and oversized forms never enter the pending inbox", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		expect(() => store.create({ ...input, html: "<form><p>No control</p></form>" }, "one")).toThrow();
		expect(() => store.create({ ...input, html: `<form>${"x".repeat(65536)}</form>` }, "two")).toThrow();
		expect(log.entries).toEqual([]);
	});

	test("queue overflow preserves existing questions and a withdrawal frees capacity", () => {
		const store = new QuestionStore("a", journal().append);
		for (let i = 0; i < MAX_PENDING; i++) store.create(input, `call-${i}`);
		expect(() => store.create(input, "overflow")).toThrow("pending");
		store.withdraw(store.list()[0]!.id, "No longer required");
		store.create(input, "replacement");
		expect(store.list().filter(question => question.status === "pending")).toHaveLength(MAX_PENDING);
	});

	test("required answers are validated and double submission cannot overwrite user input", () => {
		const store = new QuestionStore("a", journal().append);
		const question = store.create(input, "one");
		expect(() => store.submit(question.id, {}, [])).toThrow("target");
		store.submit(question.id, { target: "staging" }, []);
		expect(() => store.submit(question.id, { target: "production" }, [])).toThrow("pending");
		expect(() => store.withdraw(question.id, "Ignore answer")).toThrow("answered");
		expect(store.get(question.id)?.answer?.data).toEqual({ target: "staging" });
	});

	test("explicit numeric zero survives replay while an unchecked checkbox stays absent", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		const question = store.create(
			{
				...input,
				html: '<form><input type="number" name="count"><input type="checkbox" name="approve" value="yes"></form>',
			},
			"one",
		);
		store.submit(question.id, { count: 0 }, []);
		const restored = new QuestionStore("a", log.append);
		restored.restore(log.entries);
		expect(restored.get(question.id)?.answer?.data).toEqual({ count: 0 });
		expect(restored.get(question.id)?.delivery).toBe("unconfirmed");
	});

	test("only a matching conversation message confirms delivery after resume", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		const question = store.create(input, "one");
		store.submit(question.id, { target: "staging" }, []);
		const answer = store.get(question.id)!.answer!;
		expect(store.observe(recorded("other", question.id, answer.id))).toBe(false);
		log.entries.push({
			type: "message",
			id: "answer-entry",
			parentId: log.entries.at(-1)!.id,
			timestamp: new Date().toISOString(),
			message: recorded("a", question.id, answer.id),
		});
		store.restore(log.entries);
		expect(store.get(question.id)?.delivery).toBe("recorded");
		store.restore(log.entries.slice(0, -1));
		expect(store.get(question.id)?.delivery).toBe("unconfirmed");
	});

	test("custom_message receipts match session, question, answer and custom type on restore", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		const question = store.create(input, "one");
		store.submit(question.id, { target: "staging" }, []);
		const answerId = store.get(question.id)!.answer!.id;
		const receipt = recordedEntry("a", question.id, answerId);
		for (const wrong of [
			recordedEntry("other", question.id, answerId),
			recordedEntry("a", "other-question", answerId),
			recordedEntry("a", question.id, "other-answer"),
			{ ...receipt, customType: "unrelated" },
		]) {
			expect(store.observeEntry(wrong)).toBe(false);
			store.restore([...log.entries, wrong]);
			expect(store.get(question.id)?.delivery).toBe("unconfirmed");
		}
		store.restore([...log.entries, receipt]);
		expect(store.get(question.id)?.delivery).toBe("recorded");
		expect(store.errors).toEqual([]);
		// Missing evidence stays uncertain, never implicitly accepted or resent.
		store.restore(log.entries);
		expect(store.get(question.id)?.delivery).toBe("unconfirmed");
	});

	test("forks and clear boundaries do not resurrect foreign or pre-clear questions", () => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		store.create(input, "one");
		const child = new QuestionStore("b", log.append);
		child.restore(log.entries);
		expect(child.list()).toEqual([]);
		log.entries.push({
			type: "reset_boundary",
			id: "reset",
			parentId: log.entries.at(-1)!.id,
			timestamp: new Date().toISOString(),
		});
		store.restore(log.entries);
		expect(store.list()).toEqual([]);
	});

	test("persistence rejection does not claim a question was queued", () => {
		const store = new QuestionStore("a", () => {
			throw new Error("disk rejected");
		});
		expect(() => store.create(input, "one")).toThrow("disk rejected");
		expect(store.list()).toEqual([]);
	});

	test.each<{ name: string; data: HtmlFormData }>([
		{ name: "missing required answer", data: {} },
		{ name: "unknown answer field", data: { target: "staging", approve: "yes" } },
	])("corrupted replay rejects $name instead of exposing it for delivery", ({ data }) => {
		const log = journal();
		const store = new QuestionStore("a", log.append);
		const question = store.create(input, "one");
		log.append({
			version: 1,
			sessionId: "a",
			kind: "submitted",
			requestId: question.id,
			answer: { id: "corrupt-answer", data, notes: [] },
		});
		store.restore(log.entries);
		expect(store.errors).toHaveLength(1);
		expect(store.get(question.id)?.status).toBe("pending");
		expect(() => store.submit(question.id, { target: "production" }, [])).toThrow("history");
	});

	test("unknown journal versions surface an error rather than being interpreted as approval", () => {
		const log = journal();
		log.entries.push({
			type: "custom",
			id: "bad",
			parentId: null,
			timestamp: new Date().toISOString(),
			customType: EVENT_TYPE,
			data: { version: 999, kind: "submitted", sessionId: "a" },
		});
		const store = new QuestionStore("a", log.append);
		store.restore(log.entries);
		expect(store.errors).toHaveLength(1);
		expect(() => store.create(input, "one")).toThrow("history");
	});
});
