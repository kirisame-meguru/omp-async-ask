import { expect, test } from "bun:test";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { AnswerDelivery, type DeliveryPort } from "../src/delivery";
import { QuestionStore } from "../src/state";
import { input, journal, recorded, recordedEntry } from "./helpers";

function setup() {
	const log = journal();
	const store = new QuestionStore("a", log.append);
	const sent: CustomMessagePayload[] = [];
	let owner = "a";
	let idle = false;
	const port: DeliveryPort = {
		sessionId: () => owner,
		isIdle: () => idle,
		entries: () => log.entries,
		send: (message, options) => {
			expect(options).toEqual(idle ? { triggerTurn: true } : { deliverAs: "aside" });
			sent.push(message);
		},
	};
	const delivery = new AnswerDelivery(store, port);
	return {
		log,
		store,
		sent,
		port,
		delivery,
		switchOwner: () => {
			owner = "b";
		},
		settle: () => {
			idle = true;
			delivery.settle();
		},
	};
}

test("an agent answer is attributed to the agent, journaled, and never presented as the user's", () => {
	const { store, delivery, sent, log } = setup();
	const question = store.create(input, "one");
	delivery.submitWithReceipt(question.id, { target: "staging" }, [], "0-Helper");
	expect(sent[0]).toMatchObject({ attribution: "agent" });
	const content = JSON.stringify(sent[0]);
	expect(content).toContain("Agent 0-Helper answered");
	expect(content).not.toContain("The user submitted");
	const restored = new QuestionStore("a", () => {});
	restored.restore(log.entries);
	expect(restored.errors).toEqual([]);
	expect(restored.get(question.id)?.answer?.by).toBe("0-Helper");
});

test("an idle submission explicitly starts a turn instead of relying on background-aside wake-up", () => {
	const { store, delivery, port, sent, settle } = setup();
	const question = store.create(input, "one");
	settle();
	const options: unknown[] = [];
	const send = port.send;
	port.send = (message, dispatch) => {
		options.push(dispatch);
		send(message, dispatch);
	};
	delivery.submit(question.id, { target: "staging" }, []);
	expect(options).toEqual([{ triggerTurn: true }]);
	expect(sent).toHaveLength(1);
	expect(sent[0]).toMatchObject({ attribution: "user" });
	expect(store.get(question.id)?.delivery).toBe("queued");
	// Observing idle again is not another user action and must not dispatch twice.
	settle();
	expect(sent).toHaveLength(1);
});

test("submitting an answer does not await an executing tool or generate duplicate dispatch", async () => {
	const activeTool = Promise.withResolvers<void>();
	let finished = false;
	void activeTool.promise.then(() => {
		finished = true;
	});
	const { store, delivery, sent } = setup();
	const question = store.create(input, "one");
	delivery.submit(question.id, { target: "staging" }, []);
	expect(finished).toBe(false);
	expect(store.get(question.id)?.delivery).toBe("queued");
	expect(sent).toHaveLength(1);
	expect(() => delivery.submit(question.id, { target: "production" }, [])).toThrow();
	expect(() => delivery.retry(question.id)).toThrow("queued");
	expect(sent).toHaveLength(1);
	activeTool.resolve();
	await activeTool.promise;
	const answer = store.get(question.id)!.answer!;
	delivery.observe(recorded("a", question.id, answer.id));
	expect(store.get(question.id)?.delivery).toBe("recorded");
});

test("an immediate delivery event cannot be overwritten with queued state", () => {
	const { store, delivery, port } = setup();
	const question = store.create(input, "one");
	port.send = () => delivery.observe(recorded("a", question.id, store.get(question.id)!.answer!.id));
	delivery.submit(question.id, { target: "staging" }, []);
	expect(store.get(question.id)?.delivery).toBe("recorded");
});

test("stale callbacks after a session switch or disposal cannot submit into another session", () => {
	const { store, delivery, sent, switchOwner } = setup();
	const question = store.create(input, "one");
	switchOwner();
	expect(() => delivery.submit(question.id, { target: "staging" }, [])).toThrow("session");
	expect(store.get(question.id)?.status).toBe("pending");
	delivery.dispose();
	expect(() => delivery.retry(question.id)).toThrow("session");
	expect(sent).toEqual([]);
});

test("send failure preserves the submitted answer as failed for explicit retry", () => {
	const { store, delivery, port, sent } = setup();
	const question = store.create(input, "one");
	port.send = () => {
		throw new Error("transport rejected");
	};
	expect(() => delivery.submit(question.id, { target: "staging" }, [])).toThrow("transport rejected");
	const answerId = store.get(question.id)!.answer!.id;
	expect(store.get(question.id)?.delivery).toBe("failed");
	port.send = message => {
		sent.push(message);
	};
	delivery.retry(question.id);
	expect(store.get(question.id)?.answer?.id).toBe(answerId);
	expect(sent).toHaveLength(1);
});

test("settling without an observed answer exposes uncertainty but does not automatically retry", () => {
	const { store, delivery, sent, settle } = setup();
	const question = store.create(input, "one");
	delivery.submit(question.id, { target: "staging" }, []);
	delivery.settle();
	expect(store.get(question.id)?.delivery).toBe("queued");
	settle();
	expect(store.get(question.id)?.delivery).toBe("unconfirmed");
	expect(sent).toHaveLength(1);
});

test("retry reconciles a recorded message before dispatching again", () => {
	const { store, delivery, sent, log } = setup();
	const question = store.create(input, "one");
	store.submit(question.id, { target: "staging" }, []);
	const answerId = store.get(question.id)!.answer!.id;
	log.entries.push({
		type: "message",
		id: "message",
		parentId: log.entries.at(-1)!.id,
		timestamp: new Date().toISOString(),
		message: recorded("a", question.id, answerId),
	});
	delivery.retry(question.id);
	expect(store.get(question.id)?.delivery).toBe("recorded");
	expect(sent).toEqual([]);
});

test("settling recognizes actual custom_message receipts even without a message_end event", () => {
	const { store, delivery, sent, log, settle } = setup();
	const question = store.create(input, "one");
	delivery.submit(question.id, { target: "staging" }, []);
	const answerId = store.get(question.id)!.answer!.id;
	log.entries.push(recordedEntry("a", question.id, answerId));
	settle();
	expect(store.get(question.id)?.delivery).toBe("recorded");
	delivery.retry(question.id);
	expect(sent).toHaveLength(1);
	const restored = new QuestionStore("a", log.append);
	restored.restore(log.entries);
	expect(restored.get(question.id)?.delivery).toBe("recorded");
});

test("an uncertain answer is reconciled from custom_message before any explicit resend", () => {
	const { store, delivery, sent, log, settle } = setup();
	const question = store.create(input, "one");
	delivery.submit(question.id, { target: "staging" }, []);
	settle();
	expect(store.get(question.id)?.delivery).toBe("unconfirmed");
	log.entries.push(recordedEntry("a", question.id, store.get(question.id)!.answer!.id));
	delivery.retry(question.id);
	expect(store.get(question.id)?.delivery).toBe("recorded");
	expect(sent).toHaveLength(1);
});
