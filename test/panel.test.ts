import { afterEach, expect, test } from "bun:test";
import type { KeyEvent, UiNode } from "@oh-my-pi/pi-tui";
import { QuestionPanel } from "../src/panel";
import { QuestionStore } from "../src/state";
import { input, journal } from "./helpers";
import { UiHarness } from "./ui-harness";

const harnesses: UiHarness[] = [];
afterEach(() => { for (const harness of harnesses.splice(0)) harness.dispose(); });
const key = (id: string, text?: string): KeyEvent => ({ id, text, kind: "press", raw: text ?? "" });
function fixture(html = '<form><fieldset><legend>Format</legend><label><input type="radio" name="format" value="pdf">PDF</label><label><input type="radio" name="format" value="markdown">Markdown</label></fieldset></form>') {
	const store = new QuestionStore("fixture", journal().append);
	const first = store.create({ ...input, html }, "first");
	const second = store.create({ ...input, html, title: "Second" }, "second");
	let panel!: QuestionPanel;
	let handler: ((key: KeyEvent) => boolean) | undefined;
	const harness = new UiHarness(host => {
		panel = new QuestionPanel({
			questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
			submit: (id, data, notes) => { store.submit(id, data, notes); }, retry: id => store.setDelivery(id, "queued"), close: () => {},
		}, host, ".", callback => { handler = callback; return () => { handler = undefined; }; });
		return panel.view();
	});
	harnesses.push(harness);
	const nodes = (id: string) => {
		const root = harness.find(node => node.key() === id);
		const result: UiNode[] = [];
		const visit = (node: UiNode) => { result.push(node); node.children().forEach(visit); };
		visit(root);
		return result;
	};
	const select = (id: string, item: string) => harness.event(nodes(id).find(n => n.kind === "list")!, { type: "select", key: "", item });
	const submit = (id: string) => panel.form(id)!.model.submit();
	return { store, first, second, panel, harness, nodes, select, submit, key: (event: KeyEvent) => handler?.(event) };
}

test("panel opens inline without overlay or automatic key ownership and reserves clearance", () => {
	const fx = fixture();
	expect(fx.harness.findAll(n => n.kind === "tabs")).toEqual([]);
	expect(fx.harness.find(n => n.props().role === "async-ask.clearance").props()).toMatchObject({ min: { h: "1lines" } });
	const card = fx.harness.find(n => n.props().role === "async-ask.panel");
	fx.harness.event(card, { type: "toggle", key: "", collapsed: false });
	expect(fx.harness.findAll(n => n.kind === "overlay")).toEqual([]);
	expect(fx.harness.findAll(n => n.props().role === "async-ask.question")).toHaveLength(2);
	expect(fx.key(key("a", "a"))).toBe(false);
	expect(fx.panel.form(fx.first.id)!.model.focused()).toBe(false);
	expect(fx.harness.findAll(n => n.kind === "elapsed")).toHaveLength(0);
	expect(card.props()).not.toHaveProperty("target");
	const snapshot = fx.harness.snapshot();
	expect(snapshot).not.toContain(input.blockedWork);
	expect(snapshot).not.toContain("Cancel skips");
	expect(snapshot).not.toContain("still pending");
	expect(fx.nodes(fx.first.id).some(n => n.kind === "list")).toBe(true);
});

test("second form submits independently without losing first draft", () => {
	const fx = fixture();
	fx.panel.open();
	fx.select(fx.first.id, "o0");
	fx.select(fx.second.id, "o1");
	fx.submit(fx.second.id);
	expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "markdown" });
	expect(fx.store.get(fx.first.id)?.status).toBe("pending");
	fx.submit(fx.first.id);
	expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ format: "pdf" });
	fx.panel.open();
	expect(fx.harness.findAll(n => n.props().role === "async-ask.question")).toHaveLength(2);
});

test("claim forwards keys; Escape, collapse, tabs, submission and disposal release ownership", () => {
	const fx = fixture('<form><label>Destination<input name="target"></label></form>');
	fx.panel.open();
	fx.panel.claim(fx.first.id);
	expect(fx.key(key("a", "a"))).toBe(true);
	expect(fx.panel.form(fx.first.id)!.model.data()).toEqual({ target: "a" });
	expect(fx.key(key("escape"))).toBe(true);
	expect(fx.key(key("b", "b"))).toBe(false);
	fx.panel.claim(fx.first.id);
	fx.panel.collapse();
	expect(fx.key(key("b", "b"))).toBe(false);
	fx.panel.open();
	fx.panel.claim(fx.first.id);
	fx.panel.switchTab("answered");
	expect(fx.key(key("b", "b"))).toBe(false);
	fx.panel.switchTab("pending");
	fx.panel.claim(fx.first.id);
	fx.submit(fx.first.id);
	expect(fx.key(key("b", "b"))).toBe(false);
	expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ target: "a" });
	fx.panel.claim(fx.second.id);
	fx.panel.dispose();
	expect(fx.key(key("b", "b"))).toBeUndefined();
});

test("new questions do not steal claimed keys; stale and hidden forms cannot submit", () => {
	const fx = fixture();
	fx.panel.open();
	fx.select(fx.second.id, "o1");
	const first = fx.panel.form(fx.first.id)!;
	const second = fx.panel.form(fx.second.id)!;
	fx.store.create({ ...input, title: "Third" }, "third");
	expect(second.model.focused()).toBe(true);
	fx.store.withdraw(fx.first.id, "Resolved");
	first.model.submit();
	expect(fx.store.get(fx.first.id)?.status).toBe("withdrawn");
	fx.panel.collapse();
	second.model.submit();
	expect(fx.store.get(fx.second.id)?.status).toBe("pending");
	fx.panel.open();
	fx.panel.switchTab("answered");
	second.model.submit();
	expect(fx.store.get(fx.second.id)?.status).toBe("pending");
	fx.panel.switchTab("pending");
	fx.submit(fx.second.id);
	expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "markdown" });
});

test("Other and option notes stay with their own forms", () => {
	const fx = fixture();
	fx.panel.open();
	fx.select(fx.second.id, "other");
	fx.panel.form(fx.second.id)!.model.paste("Text export");
	fx.submit(fx.second.id);
	expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "Text export" });
	fx.select(fx.first.id, "o0");
	const model = fx.panel.form(fx.first.id)!.model;
	model.startNote();
	model.paste("Keep formatting");
	model.saveNote();
	fx.submit(fx.first.id);
	expect(fx.store.get(fx.first.id)?.answer?.notes[0]?.text).toBe("Keep formatting");
});

test("skip retains defaults and drafts, includes later arrivals and starts a fresh pass on reopen", () => {
	const fx = fixture();
	fx.panel.open();
	fx.select(fx.first.id, "o1");
	const later = fx.store.create({ ...input, title: "Later" }, "later");
	fx.panel.form(fx.first.id)!.model.cancel();
	fx.panel.form(fx.second.id)!.model.cancel();
	expect(fx.harness.findAll(n => n.kind === "tabs")).toHaveLength(1);
	fx.panel.form(later.id)!.model.cancel();
	expect(fx.harness.findAll(n => n.kind === "tabs")).toEqual([]);
	expect(fx.store.list().every(q => q.status === "pending")).toBe(true);
	fx.panel.open();
	fx.panel.form(fx.first.id)!.model.cancel();
	expect(fx.harness.findAll(n => n.kind === "tabs")).toHaveLength(1);
	fx.submit(fx.first.id);
	expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ format: "markdown" });
});

test("pointer edits retain values across collapse and resize recomputes height bound", () => {
	const fx = fixture('<form><label>Destination<input name="target" required></label></form>');
	fx.panel.open();
	const field = fx.nodes(fx.first.id).find(n => n.kind === "input")!;
	fx.harness.event(field, { type: "edit", key: "", from: 0, to: 0, text: "staging", cursor: 7, len: 0 });
	fx.panel.collapse();
	fx.panel.open();
	expect(fx.harness.find(n => n.props().role === "async-ask.body").props()).toMatchObject({ max: { h: "16lines" } });
	fx.harness.resize(12);
	expect(fx.harness.find(n => n.props().role === "async-ask.body").props()).toMatchObject({ max: { h: "6lines" } });
	fx.submit(fx.first.id);
	expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ target: "staging" });
});

test("last-answer send failure remains visible; retry requires explicit confirmation", () => {
	const fx = fixture();
	fx.store.withdraw(fx.second.id, "Resolved");
	const submit = fx.panel.actions.submit;
	fx.panel.actions.submit = (id, data, notes) => {
		submit(id, data, notes);
		fx.store.setDelivery(id, "failed");
		throw new Error("Synthetic delivery failure");
	};
	fx.panel.open();
	fx.select(fx.first.id, "o0");
	fx.submit(fx.first.id);
	expect(fx.harness.snapshot()).toContain("Synthetic delivery failure");
	expect(fx.harness.find(n => n.kind === "tabs").props()).toMatchObject({ active: "answered" });
	fx.panel.retry(fx.first.id);
	expect(fx.store.get(fx.first.id)?.delivery).toBe("failed");
	fx.panel.keep();
	fx.panel.retry(fx.first.id);
	fx.panel.confirm();
	expect(fx.store.get(fx.first.id)?.delivery).toBe("queued");
	expect(fx.harness.snapshot()).not.toContain("Synthetic delivery failure");
});
