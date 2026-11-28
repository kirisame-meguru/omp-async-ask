import { expect, test } from "bun:test";
import { createSurface, type UiNode } from "@oh-my-pi/pi-tui";
import { NativeBackend } from "@oh-my-pi/pi-tui/native/backend";
import { TspConnection } from "@oh-my-pi/pi-tui/native/connection";
import { startProcessDriver } from "@oh-my-pi/pi-tui/testing/process-driver";
import { TSP_KINDS, type TspFrame } from "@oh-my-pi/pi-wire";
import { QuestionInbox } from "../src/ui";
import { QuestionPanel } from "../src/panel";
import { QuestionStore } from "../src/state";
import { input, journal } from "./helpers";

test("real native backend routes form edit and submit frames without legacy fallback", async () => {
	const terminal = await startProcessDriver();
	const connection = new TspConnection(terminal.driver, {
		r: "hello", v: 1, term: "tern-test", kinds: TSP_KINDS, features: [], credits: 128,
	});
	const store = new QuestionStore("native", journal().append);
	const question = store.create(input, "one");
	let closed = false;
	let root!: UiNode;
	const surface = createSurface(() => {
		const inbox = new QuestionInbox({
			questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
			submit: (id, data, notes) => { store.submit(id, data, notes); },
			retry: id => store.setDelivery(id, "queued"), close: () => { closed = true; },
		}, { size: () => ({ columns: 100, rows: 30 }), requestRender: () => {}, suspend: run => run() });
		return { dock: root = inbox.view() };
	});
	const frames: TspFrame[] = [];
	const backend = new NativeBackend({ surface, onFrame: frame => frames.push(frame) });
	try {
		backend.start(connection);
		const nodes: UiNode[] = [];
		const visit = (node: UiNode) => { nodes.push(node); node.children().forEach(visit); };
		visit(root);
		const field = nodes.find(node => node.kind === "input")!;
		expect(backend.idOf(field)).toBeDefined();
		expect(JSON.stringify(frames)).not.toContain("<form");
		const send = (event: object) => terminal.feed(`\x1b_tsp;e;${JSON.stringify({ sf: backend.id, ...event })}\x1b\\`);
		send({ ev: "edit", id: backend.idOf(field), from: 0, to: 0, text: "staging", cursor: 7, len: 0 });
		backend.flush();
		// Editing rebuilds reactive action nodes; address the current wire id, not a retired button.
		nodes.length = 0;
		visit(root);
		const submit = nodes.find(node => node.props().role === "omp.btn" && node.props().actions?.click === "submit")!;
		expect(submit).toBeDefined();
		expect(backend.idOf(submit)).toBeDefined();
		send({ ev: "action", id: backend.idOf(submit), act: "submit", mods: [] });
		backend.flush();
		expect(store.get(question.id)?.answer?.data).toEqual({ target: "staging" });
		expect(closed).toBe(true);
	} finally {
		backend.dispose();
		connection.close();
		surface.dispose();
		await terminal.driver.stop();
	}
});

test("native panel sends a bounded scroll container, not a clipped column", async () => {
	const terminal = await startProcessDriver();
	const connection = new TspConnection(terminal.driver, {
		r: "hello", v: 1, term: "tern-test", kinds: TSP_KINDS, features: [], credits: 128,
	});
	const store = new QuestionStore("native-panel", journal().append);
	store.create({ ...input, html: `<form>${"<p>Long question context.</p>".repeat(80)}<label>Target<input name="target"></label></form>` }, "long");
	const surface = createSurface(() => {
		const panel = new QuestionPanel({
			questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
			submit: (id, data, notes) => { store.submit(id, data, notes); },
			retry: () => {}, close: () => {},
		}, { size: () => ({ columns: 100, rows: 30 }), requestRender: () => {}, suspend: run => run() });
		panel.open();
		return { dock: panel.view() };
	});
	const frames: TspFrame[] = [];
	const backend = new NativeBackend({ surface, onFrame: frame => frames.push(frame) });
	try {
		backend.start(connection);
		const wire = JSON.stringify(frames);
		const nodes: { k?: string; p?: { role?: string; max?: unknown } }[] = [];
		JSON.parse(wire, (_key, value) => {
			if (value?.p?.role === "async-ask.body") nodes.push(value);
			return value;
		});
		expect(nodes).toHaveLength(1);
		expect(nodes[0]).toMatchObject({ k: "scroll", p: { max: { h: "20lines" } } });
		expect(wire).toContain("Submit");
	} finally {
		backend.dispose();
		connection.close();
		surface.dispose();
		await terminal.driver.stop();
	}
});
