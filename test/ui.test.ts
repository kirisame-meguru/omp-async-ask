import { afterEach, expect, test } from "bun:test";
import { UiNode } from "@oh-my-pi/pi-tui";
import { QuestionStore } from "../src/state";
import { QuestionInbox, QuestionIndicator, type InboxActions } from "../src/ui";
import { UiHarness } from "./ui-harness";
import { input, journal } from "./helpers";

const harnesses: UiHarness[] = [];
afterEach(() => { for (const harness of harnesses.splice(0)) harness.dispose(); });
function fixture() {
	const store = new QuestionStore("a", journal().append);
	let closes = 0;
	const actions: InboxActions = {
		questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
		submit: (id, data, notes) => { store.submit(id, data, notes); },
		retry: id => store.setDelivery(id, "queued"), close: () => { closes++; },
	};
	return { store, actions, closes: () => closes };
}
function mount(actions: InboxActions) {
	let inbox!: QuestionInbox;
	const harness = new UiHarness(host => {
		inbox = new QuestionInbox(actions, host);
		return inbox.view();
	});
	harnesses.push(harness);
	return { inbox, harness };
}
function submit(harness: UiHarness) {
	harness.action(harness.find(node => node.props().role === "omp.btn" && node.props().actions?.click === "submit"), "submit");
}

test("reactive indicator highlights only pending; errors and send failures remain separate warnings", () => {
	const fx = fixture();
	let opened = 0;
	const harness = new UiHarness(() => QuestionIndicator(fx.actions, () => opened++));
	harnesses.push(harness);
	expect(harness.root.props()).toMatchObject({ variant: "default", tone: "neutral" });
	const first = fx.store.create(input, "one");
	expect(harness.root.props()).toMatchObject({ variant: "primary", tone: "accent", icon: "inbox" });
	harness.action(harness.root, "open");
	expect(opened).toBe(1);
	fx.store.withdraw(first.id, "Resolved");
	const second = fx.store.create(input, "two");
	fx.store.submit(second.id, { target: "staging" }, []);
	fx.store.setDelivery(second.id, "unconfirmed");
	expect(harness.root.props()).toMatchObject({ variant: "default", tone: "neutral", icon: "inbox", text: "Questions · 0 pending" });
	fx.store.setDelivery(second.id, "failed");
	expect(harness.root.props()).toMatchObject({ icon: "warn", text: "Questions · 0 pending · 1 send failed" });
	fx.store.setDelivery(second.id, "recorded");
	expect(harness.root.props()).toMatchObject({ icon: "inbox" });
	const broken = new UiHarness(() => QuestionIndicator({ ...fx.actions, errors: () => ["Malformed history"] }, () => opened++));
	harnesses.push(broken);
	expect(broken.root.props()).toMatchObject({ icon: "warn", tone: "neutral" });
});

test("real terminal Escape folds then closes without submitting a default", () => {
	const fx = fixture();
	const question = fx.store.create({ ...input, html: '<form><input name="target" value="staging"></form>' }, "one");
	const { inbox, harness } = mount(fx.actions);
	harness.terminal.press("escape");
	expect(inbox.debugState()).toMatchObject({ expanded: null });
	harness.terminal.press("escape");
	expect(fx.closes()).toBe(1);
	expect(fx.store.get(question.id)?.status).toBe("pending");
});

test("new questions and accordion folds retain drafts and reject stale submissions", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	const { inbox, harness } = mount(fx.actions);
	harness.terminal.type("saved draft");
	const original = inbox.form!;
	const card = harness.find(node => node.key() === second.id);
	harness.event(card, { type: "toggle", key: "", collapsed: false });
	original.model.submit();
	expect(fx.store.get(first.id)?.status).toBe("pending");
	fx.store.create({ ...input, title: "Third" }, "three");
	expect(inbox.debugState()).toMatchObject({ selected: second.id, form: second.id });
	inbox.expand(first.id);
	expect(inbox.form).toBe(original);
	expect(inbox.form!.model.data()).toEqual({ target: "saved draft" });
	inbox.expand(second.id);
	fx.store.withdraw(first.id, "Found it");
	original.model.submit();
	expect(fx.store.get(first.id)?.status).toBe("withdrawn");
	expect(inbox.debugState()).toMatchObject({ expanded: second.id });
});

test("native form edits and submit advance the inbox; final submission closes after delivery finishes", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const next = fx.store.create({ ...input, title: "Next" }, "two");
	const { inbox, harness } = mount({
		...fx.actions,
		submit: (id, data, notes) => {
			fx.store.submit(id, data, notes);
			expect(fx.closes()).toBe(0);
			fx.store.setDelivery(id, "queued");
		},
	});
	const field = harness.find(node => node.kind === "input");
	harness.event(field, { type: "edit", key: "", from: 0, to: 0, text: "staging", cursor: 7, len: 0 });
	submit(harness);
	expect(fx.store.get(first.id)?.answer?.data).toEqual({ target: "staging" });
	expect(inbox.debugState()).toMatchObject({ expanded: next.id });
	harness.terminal.type("production");
	submit(harness);
	expect(fx.closes()).toBe(1);
	expect(fx.store.get(next.id)?.delivery).toBe("queued");
	harness.terminal.press("escape");
	expect(fx.closes()).toBe(1);
	const history = mount(fx.actions);
	expect(history.inbox.debugState()).toMatchObject({ tab: "answered", form: null });
});

test("withdrawal while open closes safely without accepting retained form callbacks", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const { inbox, harness } = mount(fx.actions);
	const stale = inbox.form!;
	fx.store.withdraw(question.id, "Resolved");
	stale.model.paste("staging");
	stale.model.submit();
	harness.terminal.press("enter");
	expect(fx.store.get(question.id)?.status).toBe("withdrawn");
	expect(fx.closes()).toBe(1);
});

test("skip advances once through pending questions without sending defaults", () => {
	const fx = fixture();
	const first = fx.store.create(input, "one");
	const second = fx.store.create({ ...input, title: "Second" }, "two");
	const { inbox } = mount(fx.actions);
	inbox.form!.model.cancel();
	expect(inbox.debugState()).toMatchObject({ expanded: second.id, skipped: [first.id] });
	inbox.form!.model.cancel();
	expect(inbox.debugState()).toMatchObject({ expanded: null, skipped: [first.id, second.id] });
	expect(fx.store.list().every(q => q.status === "pending")).toBe(true);
	expect(fx.closes()).toBe(0);
});

test("discard confirmation keeps drafts until explicitly accepted", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const { inbox, harness } = mount(fx.actions);
	harness.terminal.type("draft");
	inbox.close();
	expect(inbox.debugState()).toMatchObject({ confirmation: "discard" });
	expect(fx.closes()).toBe(0);
	inbox.keep();
	expect(inbox.form!.model.data()).toEqual({ target: "draft" });
	inbox.close();
	inbox.confirm();
	expect(fx.closes()).toBe(1);
	expect(fx.store.get(question.id)?.status).toBe("pending");
});

test("both uncertain and failed delivery require resend confirmation", () => {
	for (const delivery of ["unconfirmed", "failed"] as const) {
		const fx = fixture();
		const question = fx.store.create(input, delivery);
		fx.store.submit(question.id, { target: "staging" }, []);
		fx.store.setDelivery(question.id, delivery);
		const { inbox } = mount(fx.actions);
		expect(inbox.debugState()).toMatchObject({ tab: "answered", form: null });
		inbox.retry();
		expect(fx.store.get(question.id)?.delivery).toBe(delivery);
		inbox.keep();
		inbox.retry();
		inbox.confirm();
		expect(fx.store.get(question.id)?.delivery).toBe("queued");
	}
});

test("synchronous send failure remains open on answered tab for recovery", () => {
	const fx = fixture();
	const question = fx.store.create(input, "one");
	const { inbox, harness } = mount({ ...fx.actions, submit: (id, data, notes) => {
		fx.store.submit(id, data, notes);
		fx.store.setDelivery(id, "failed");
		throw new Error("Sending failed");
	} });
	harness.terminal.type("staging");
	submit(harness);
	expect(fx.closes()).toBe(0);
	expect(inbox.debugState()).toMatchObject({ tab: "answered", expanded: question.id });
	expect(harness.snapshot()).toContain("Sending failed");
});

test("pending and answered tabs filter nodes, keep drafts and gate stale models", () => {
	const fx = fixture();
	const pending = fx.store.create(input, "pending");
	const answered = fx.store.create({ ...input, title: "Earlier" }, "answered");
	fx.store.submit(answered.id, { target: "production" }, []);
	const { inbox, harness } = mount(fx.actions);
	harness.terminal.type("draft");
	const form = inbox.form!;
	const tabs = harness.find(node => node.kind === "tabs");
	harness.event(tabs, { type: "select", key: "", item: "answered" });
	expect(inbox.debugState()).toMatchObject({ tab: "answered", expanded: answered.id, form: null });
	expect(harness.findAll(node => node.key() === pending.id)).toEqual([]);
	form.model.submit();
	expect(fx.store.get(pending.id)?.status).toBe("pending");
	inbox.switchTab("pending");
	expect(inbox.form).toBe(form);
	expect(form.model.data()).toEqual({ target: "draft" });
	expect(harness.findAll(node => node.key() === answered.id)).toEqual([]);
	expect(harness.root).toBeInstanceOf(UiNode);
});
