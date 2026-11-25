import { beforeAll, expect, test } from "bun:test";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./tsp-harness";
import { QuestionStore } from "../src/state";
import { QuestionInbox, QuestionIndicator, type InboxActions } from "../src/ui";
import { input, journal } from "./helpers";

beforeAll(async () => {
	await initTheme(false);
});

function fixture() {
	const store = new QuestionStore("a", journal().append);
	let closed = false;
	const actions: InboxActions = {
		questions: () => store.list(),
		errors: () => store.errors,
		subscribe: callback => store.subscribe(callback),
		submit: (id, data, notes) => {
			store.submit(id, data, notes);
		},
		retry: id => {
			store.setDelivery(id, "queued");
		},
		close: () => {
			closed = true;
		},
	};
	return { store, actions, closed: () => closed };
}

test("indicator highlights only pending questions, not missing delivery receipts", () => {
	const fx = fixture();
	let opened = 0;
	const indicator = new QuestionIndicator(fx.actions, () => opened++);
	expect(indicator.describe().p).toMatchObject({ variant: "default", tone: "neutral" });
	const first = fx.store.create(input, "one");
	const highlighted = indicator.describe();
	expect(highlighted.p).toMatchObject({ variant: "primary", tone: "accent", icon: "inbox" });
	expect(indicator.describe()).toBe(highlighted);
	indicator.handleNativeEvent({ type: "action", key: "", act: "open", mods: [] });
	expect(opened).toBe(1);
	fx.store.withdraw(first.id, "Resolved independently");
	expect(indicator.describe().p).toMatchObject({ variant: "default", tone: "neutral" });
	const second = fx.store.create(input, "two");
	fx.store.submit(second.id, { target: "staging" }, []);
	fx.store.setDelivery(second.id, "unconfirmed");
	expect(indicator.describe().p).toMatchObject({
		variant: "default",
		tone: "neutral",
		icon: "inbox",
		text: "Questions · 0 pending",
	});
	fx.store.setDelivery(second.id, "recorded");
	expect(indicator.describe().p).toMatchObject({ variant: "default", tone: "neutral" });
	indicator.dispose();
});

test("indicator surfaces history errors even when no pending question was recoverable", () => {
	const fx = fixture();
	const indicator = new QuestionIndicator({ ...fx.actions, errors: () => ["Malformed history"] }, () => {});
	expect(indicator.describe().p).toMatchObject({ variant: "default", tone: "neutral", icon: "warn" });
	indicator.dispose();
});

test("a real send failure has a separate warning without the pending-question glow", () => {
	const fx = fixture();
	const indicator = new QuestionIndicator(fx.actions, () => {});
	const question = fx.store.create(input, "one");
	fx.store.submit(question.id, { target: "staging" }, []);
	fx.store.setDelivery(question.id, "failed");
	expect(indicator.describe().p).toMatchObject({
		variant: "default",
		tone: "neutral",
		icon: "warn",
		text: "Questions · 0 pending · 1 send failed",
	});
	const inbox = new QuestionInbox(fx.actions);
	inbox.handleNativeEvent({ type: "action", key: "", act: "retry", mods: [] });
	expect(inbox.debugState()).toMatchObject({ confirmation: "retry" });
	expect(fx.store.get(question.id)?.delivery).toBe("failed");
	inbox.handleNativeEvent({ type: "action", key: "", act: "confirm", mods: [] });
	expect(fx.store.get(question.id)?.delivery).toBe("queued");
	inbox.dispose();
	indicator.dispose();
});

test("Escape folds then closes without submitting the recommended default", () => {
	const fx = fixture();
	const question = fx.store.create({ ...input, html: '<form><input name="target" value="staging"></form>' }, "one");
	const inbox = new QuestionInbox(fx.actions);
	inbox.handleInput("\u001b");
	expect(inbox.debugState()).toMatchObject({ expanded: null });
	inbox.handleInput("\u001b");
	expect(fx.closed()).toBe(true);
	expect(fx.store.get(question.id)?.status).toBe("pending");
	inbox.dispose();
});

test("new questions do not steal the expanded question or replace its draft", () => {
	const fx = fixture();
	fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	const inbox = new QuestionInbox(fx.actions);
	inbox.handleNativeEvent({ type: "toggle", key: second.id, collapsed: false });
	inbox.handleInput("draft");
	fx.store.create({ ...input, title: "Third" }, "three");
	expect(inbox.debugState()).toMatchObject({ selected: second.id, form: second.id });
	expect(inbox.debugChildren[0]?.debugState?.()).toMatchObject({ data: { target: "draft" } });
	inbox.dispose();
});

test("a form withdrawn while open cannot accept a stale answer", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const inbox = new QuestionInbox(fx.actions);
	fx.store.withdraw(question.id, "Found the target independently");
	inbox.handleInput("staging");
	inbox.handleInput("\r");
	expect(fx.store.get(question.id)?.status).toBe("withdrawn");
	expect(fx.closed()).toBe(true);
	inbox.dispose();
});

test("Tern opens the first form immediately, submits it and advances to the next card", async () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const next = fx.store.create({ ...input, title: "Next question" }, "two");
	let inbox: QuestionInbox | undefined;
	const harness = await TspHarness.start(tui => {
		inbox = new QuestionInbox(fx.actions, tui);
		tui.showOverlay(inbox, { width: "90%", maxHeight: "90%" });
	});
	try {
		await harness.render();
		expect(inbox?.debugState()).toMatchObject({ form: question.id });
		harness.terminal.send("staging");
		harness.flush();
		const submit = harness.find(node => node.k === "button" && node.p?.actions?.click === "submit");
		if (!submit) throw new Error("No native form Submit action");
		expect(submit.p).toMatchObject({ text: "Send answer", variant: "primary" });
		const skip = harness.find(node => node.k === "button" && node.p?.actions?.click === "cancel");
		expect(skip?.p).toMatchObject({ text: "Skip for now", role: "omp.btn" });
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: submit.id, act: "submit", mods: [] });
		expect(fx.store.get(question.id)?.answer?.data).toEqual({ target: "staging" });
		expect(inbox?.debugState()).toMatchObject({ expanded: next.id, form: next.id });
		const answered = harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${question.id}`));
		expect(answered).toBeUndefined();
		const expanded = harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${next.id}`));
		expect(expanded?.p).toMatchObject({ collapsed: false });
		expect(harness.tui.nativeFallbackCount).toBe(0);
		expect(harness.errors).toEqual([]);
	} finally {
		inbox?.dispose();
		harness.stop();
	}
});

test("native accordion toggles keep one card open and retain drafts without submitting them", async () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	let inbox: QuestionInbox | undefined;
	const harness = await TspHarness.start(tui => {
		inbox = new QuestionInbox(fx.actions, tui);
		tui.showOverlay(inbox, { width: "90%", maxHeight: "90%" });
	});
	try {
		await harness.render();
		harness.terminal.send("saved draft");
		harness.flush();
		const firstForm = inbox!.debugChildren[0]!;
		const secondCard = harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${second.id}`))!;
		harness.event({
			ev: "toggle",
			sf: harness.terminal.surface!,
			id: secondCard.id,
			key: second.id,
			collapsed: false,
		});
		expect(inbox!.debugState()).toMatchObject({ expanded: second.id, form: second.id });
		const firstCard = harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${first.id}`))!;
		expect(firstCard.p).toMatchObject({ collapsed: true, status: "pending", note: "Skipped · still pending" });
		// Even a retained old form cannot submit after its card is folded.
		firstForm.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
		expect(fx.store.get(first.id)?.status).toBe("pending");
		harness.event({
			ev: "toggle",
			sf: harness.terminal.surface!,
			id: firstCard.id,
			key: first.id,
			collapsed: false,
		});
		expect(inbox!.debugChildren[0]).toBe(firstForm);
		expect(firstForm.debugState?.()).toMatchObject({ data: { target: "saved draft" } });
		expect(harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${second.id}`))?.p).toMatchObject({
			collapsed: true,
			status: "pending",
			note: "Skipped · still pending",
		});
		harness.event({
			ev: "toggle",
			sf: harness.terminal.surface!,
			id: firstCard.id,
			key: first.id,
			collapsed: true,
		});
		expect(inbox!.debugState()).toMatchObject({ expanded: null, form: null });
		expect(fx.store.list().every(question => question.status === "pending")).toBe(true);
		expect(harness.errors).toEqual([]);
	} finally {
		inbox?.dispose();
		harness.stop();
	}
});

test("skip advances through unanswered questions without submitting defaults or looping", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	const inbox = new QuestionInbox(fx.actions);
	inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "cancel", mods: [] });
	expect(inbox.debugState()).toMatchObject({ expanded: second.id, skipped: [first.id] });
	inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "cancel", mods: [] });
	expect(inbox.debugState()).toMatchObject({ expanded: null, skipped: [first.id, second.id] });
	expect(fx.store.list().every(question => question.status === "pending")).toBe(true);
	expect(fx.closed()).toBe(false);
	inbox.dispose();
});

test("closing retained drafts asks once and keeping them restores the expanded form", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const inbox = new QuestionInbox(fx.actions);
	inbox.handleInput("draft");
	inbox.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	expect(fx.closed()).toBe(false);
	expect(inbox.debugState()).toMatchObject({ confirmation: "discard" });
	inbox.handleNativeEvent({ type: "action", key: "", act: "keep", mods: [] });
	expect(inbox.debugState()).toMatchObject({ expanded: first.id, confirmation: null });
	expect(inbox.debugChildren[0]?.debugState?.()).toMatchObject({ data: { target: "draft" } });
	inbox.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
	inbox.handleNativeEvent({ type: "action", key: "", act: "confirm", mods: [] });
	expect(fx.closed()).toBe(true);
	expect(fx.store.get(first.id)?.status).toBe("pending");
	inbox.dispose();
});

test("delivery uncertainty remains reviewable inside an answered question without implying a missing answer", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	fx.store.submit(question.id, { target: "staging" }, []);
	fx.store.setDelivery(question.id, "unconfirmed");
	const inbox = new QuestionInbox(fx.actions);
	expect(inbox.debugState()).toMatchObject({ expanded: question.id, form: null });
	inbox.handleNativeEvent({ type: "action", key: "", act: "retry", mods: [] });
	expect(fx.store.get(question.id)?.delivery).toBe("unconfirmed");
	expect(inbox.debugState()).toMatchObject({ confirmation: "retry" });
	inbox.handleNativeEvent({ type: "action", key: "", act: "confirm", mods: [] });
	expect(fx.store.get(question.id)?.delivery).toBe("queued");
	inbox.dispose();
});

test("withdrawal of a folded draft disposes it without disturbing the current question", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	const inbox = new QuestionInbox(fx.actions);
	const oldForm = inbox.debugChildren[0]!;
	inbox.handleNativeEvent({ type: "toggle", key: second.id, collapsed: false });
	fx.store.withdraw(first.id, "Resolved independently");
	oldForm.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
	expect(fx.store.get(first.id)?.status).toBe("withdrawn");
	expect(inbox.debugState()).toMatchObject({ expanded: second.id, form: second.id });
	inbox.dispose();
});

test("the last answer closes once, after submission finishes, and history can reopen", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	let closes = 0;
	const inbox = new QuestionInbox({
		...fx.actions,
		submit: (id, data, notes) => {
			fx.store.submit(id, data, notes);
			expect(closes).toBe(0);
			fx.store.setDelivery(id, "queued");
		},
		close: () => {
			closes++;
		},
	});
	inbox.handleInput("staging");
	inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
	expect(fx.store.get(question.id)?.delivery).toBe("queued");
	expect(closes).toBe(1);
	fx.store.setDelivery(question.id, "recorded");
	inbox.handleInput("\u001b");
	expect(closes).toBe(1);
	inbox.dispose();
	const history = new QuestionInbox(fx.actions);
	expect(history.debugState()).toMatchObject({ tab: "answered", expanded: question.id });
	expect(fx.closed()).toBe(false);
	history.dispose();
});

test("a synchronous send failure stays open on the answered tab for recovery", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const inbox = new QuestionInbox({
		...fx.actions,
		submit: (id, data, notes) => {
			fx.store.submit(id, data, notes);
			fx.store.setDelivery(id, "failed");
			throw new Error("Sending failed");
		},
	});
	inbox.handleInput("staging");
	inbox.debugChildren[0]!.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
	expect(fx.closed()).toBe(false);
	expect(inbox.debugState()).toMatchObject({ tab: "answered", expanded: question.id });
	expect(inbox.render(120).join("\n")).toContain("Sending failed");
	inbox.dispose();
});

test("native pending and answered tabs filter cards and preserve drafts across switches", async () => {
	const fx = fixture();
	const pending = fx.store.create(input, "pending");
	const answered = fx.store.create({ ...input, title: "Earlier answer" }, "answered");
	fx.store.submit(answered.id, { target: "production" }, []);
	let inbox: QuestionInbox | undefined;
	const harness = await TspHarness.start(tui => {
		inbox = new QuestionInbox(fx.actions, tui);
		tui.showOverlay(inbox, { width: "90%", maxHeight: "90%" });
	});
	try {
		await harness.render();
		harness.terminal.send("saved draft");
		harness.flush();
		const draft = inbox!.debugChildren[0];
		const tabs = harness.find(node => node.k === "tabs")!;
		expect(tabs.p).toMatchObject({
			active: "pending",
			items: [
				{ id: "pending", label: "Pending (1)" },
				{ id: "answered", label: "Answered (1)" },
			],
		});
		expect(harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${answered.id}`))).toBeUndefined();
		harness.event({ ev: "select", sf: harness.terminal.surface!, id: tabs.id, item: "answered" });
		expect(inbox!.debugState()).toMatchObject({ tab: "answered", expanded: answered.id, form: null });
		expect(harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${pending.id}`))).toBeUndefined();
		expect(harness.find(node => node.p?.role === "async-ask.question" && node.id.endsWith(`/${answered.id}`))?.p).toMatchObject({
			status: "done",
		});
		draft?.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
		expect(fx.store.get(pending.id)?.status).toBe("pending");
		harness.event({ ev: "select", sf: harness.terminal.surface!, id: tabs.id, item: "pending" });
		expect(inbox!.debugChildren[0]).toBe(draft);
		expect(draft?.debugState?.()).toMatchObject({ data: { target: "saved draft" } });
		expect(fx.closed()).toBe(false);
		expect(harness.errors).toEqual([]);
	} finally {
		inbox?.dispose();
		harness.stop();
	}
});
