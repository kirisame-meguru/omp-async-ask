import { beforeAll, expect, test } from "bun:test";
import { Text } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { QuestionPanel } from "../src/panel";
import { QuestionStore } from "../src/state";
import { input, journal } from "./helpers";
import { TspHarness } from "./tsp-harness";

beforeAll(() => initTheme(false));

async function fixture(
	html = '<form><fieldset><legend>Choose a format</legend><label><input type="radio" name="format" value="pdf">PDF</label><label><input type="radio" name="format" value="markdown">Markdown</label></fieldset></form>',
) {
	const store = new QuestionStore("fixture", journal().append);
	const first = store.create({ ...input, html }, "first");
	const second = store.create({ ...input, html, title: "Second question" }, "second");
	const home = new Text("Composer", 0, 0);
	let panel!: QuestionPanel;
	const harness = await TspHarness.start((tui) => {
		panel = new QuestionPanel(
			{
				questions: () => store.list(),
				errors: () => store.errors,
				subscribe: (fn) => store.subscribe(fn),
				submit: (id, data, notes) => {
					store.submit(id, data, notes);
				},
				retry: (id) => store.setDelivery(id, "queued"),
				close: () => {},
			},
			tui,
		);
		tui.addChild(panel);
		tui.addChild(home);
		tui.setFocus(home);
	});
	const questionNodes = (id: string): TspNode[] => {
		const card = harness.find((n) => n.p?.role === "async-ask.question" && n.id.endsWith(`/${id}`));
		expect(card).toBeDefined();
		const nodes: TspNode[] = [];
		const visit = (n: TspNode) => {
			nodes.push(n);
			n.c?.forEach(visit);
		};
		visit(card!);
		return nodes;
	};
	const action = (node: TspNode, act: string) =>
		harness.event({ ev: "action", sf: harness.terminal.surface!, id: node.id, act, mods: [] });
	const toggle = () => {
		const card = harness.find((n) => n.p?.role === "async-ask.panel")!;
		if (card.k !== "card") throw new Error("Expected question card");
		harness.event({ ev: "toggle", sf: harness.terminal.surface!, id: card.id, collapsed: !card.p?.collapsed });
	};
	const select = (id: string, item: string) => {
		const list = questionNodes(id).find((n) => n.k === "list")!;
		harness.event({ ev: "select", sf: harness.terminal.surface!, id: list.id, item });
	};
	const submit = (id: string) =>
		action(questionNodes(id).find((n) => n.k === "button" && n.p?.actions?.click === "submit")!, "submit");
	const tab = (item: string) =>
		harness.event({ ev: "select", sf: harness.terminal.surface!, id: harness.find((n) => n.k === "tabs")!.id, item });
	return {
		store,
		first,
		second,
		panel,
		home,
		harness,
		action,
		toggle,
		select,
		submit,
		tab,
		questionNodes,
		stop: () => {
			panel.dispose();
			harness.stop();
		},
	};
}

test("closed panel reserves gauge clearance and opens inline without an overlay", async () => {
	const fx = await fixture();
	try {
		expect(fx.harness.find((n) => n.k === "tabs")).toBeUndefined();
		expect(fx.harness.find((n) => n.p?.role === "async-ask.clearance")?.p).toMatchObject({ min: { h: "1lines" } });
		fx.toggle();
		expect(fx.harness.find((n) => n.k === "overlay")).toBeUndefined();
		expect(fx.harness.find((n) => n.k === "tabs")?.p).toMatchObject({ active: "pending" });
		expect(fx.harness.findAll((n) => n.p?.role === "async-ask.question")).toHaveLength(2);
		expect(fx.harness.tui.getFocused()).toBe(fx.home);
		expect(fx.harness.errors).toEqual([]);
	} finally {
		fx.stop();
	}
});

test("each form has one question block, no redundant Ask chrome, and vertical options", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		const nodes = fx.harness.findAll(() => true);
		expect(nodes.filter((n) => n.k === "card")).toHaveLength(3);
		expect(nodes.some((n) => ["omp.ask.card", "omp.ask.card.head", "omp.ask.open"].includes(n.p?.role ?? ""))).toBe(
			false,
		);
		for (const id of [fx.first.id, fx.second.id]) {
			const lists = fx.questionNodes(id).filter((n) => n.k === "list");
			expect(lists).toHaveLength(1);
			expect(lists[0]!.c).toHaveLength(3);
		}
		expect(nodes.filter((n) => n.k === "elapsed")).toHaveLength(2);
		expect(nodes.some((n) => n.k === "button" && n.p?.text === "Close")).toBe(false);
		expect(nodes.some((n) => n.k === "text" && /Depends on this|Agent work continues/.test(n.p?.text ?? ""))).toBe(
			false,
		);
	} finally {
		fx.stop();
	}
});

test("second form submits independently and retains the first form's draft", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.first.id, "o0");
		fx.select(fx.second.id, "o1");
		fx.submit(fx.second.id);
		expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "markdown" });
		expect(fx.store.get(fx.first.id)?.status).toBe("pending");
		fx.submit(fx.first.id);
		expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ format: "pdf" });
		fx.panel.open();
		fx.harness.flush();
		fx.tab("answered");
		expect(fx.harness.findAll((n) => n.p?.role === "async-ask.question")).toHaveLength(2);
	} finally {
		fx.stop();
	}
});

test("collapse and tab switches retain drafts and release keyboard focus", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.first.id, "o1");
		expect(fx.harness.tui.getFocused()).not.toBe(fx.home);
		fx.toggle();
		expect(fx.harness.tui.getFocused()).toBe(fx.home);
		expect(fx.store.get(fx.first.id)?.status).toBe("pending");
		fx.toggle();
		fx.tab("answered");
		fx.tab("pending");
		fx.submit(fx.first.id);
		expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ format: "markdown" });
	} finally {
		fx.stop();
	}
});

test("new questions never steal focus and withdrawn forms reject stale events", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.second.id, "o1");
		const focused = fx.harness.tui.getFocused();
		const stale = fx.questionNodes(fx.first.id).find((n) => n.k === "button" && n.p?.actions?.click === "submit")!;
		fx.store.create({ ...input, title: "Third" }, "third");
		fx.harness.flush();
		expect(fx.harness.tui.getFocused()).toBe(focused);
		fx.store.withdraw(fx.first.id, "Resolved independently");
		fx.harness.flush();
		fx.action(stale, "submit");
		expect(fx.store.get(fx.first.id)?.status).toBe("withdrawn");
		fx.submit(fx.second.id);
		expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "markdown" });
	} finally {
		fx.stop();
	}
});

test("Other input and notes stay attached to their own form", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.second.id, "other");
		fx.harness.terminal.send("Text export");
		fx.harness.flush();
		fx.submit(fx.second.id);
		expect(fx.store.get(fx.second.id)?.answer?.data).toEqual({ format: "Text export" });
		fx.select(fx.first.id, "o0");
		fx.action(fx.questionNodes(fx.first.id).find((n) => n.k === "button" && n.p?.actions?.click === "note")!, "note");
		fx.harness.terminal.send("Keep formatting");
		fx.harness.flush();
		fx.action(fx.harness.find((n) => n.k === "button" && n.p?.actions?.click === "save-note")!, "save-note");
		fx.submit(fx.first.id);
		expect(fx.store.get(fx.first.id)?.answer?.notes[0]?.text).toBe("Keep formatting");
	} finally {
		fx.stop();
	}
});

test("skipping never submits defaults and disposal returns focus", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.first.id, "o0");
		fx.action(
			fx.questionNodes(fx.first.id).find((n) => n.k === "button" && n.p?.actions?.click === "cancel")!,
			"cancel",
		);
		expect(fx.store.list().every((q) => q.status === "pending")).toBe(true);
		fx.panel.dispose();
		expect(fx.harness.tui.getFocused()).toBe(fx.home);
	} finally {
		fx.stop();
	}
});

test("pointer-focused text inputs return to the composer on collapse and submission", async () => {
	const fx = await fixture('<form><label>Destination<input name="target" required></label></form>');
	try {
		fx.toggle();
		const inputNode = fx.questionNodes(fx.first.id).find((n) => n.k === "input")!;
		fx.harness.event({ ev: "focus", sf: fx.harness.terminal.surface!, id: inputNode.id });
		fx.harness.event({
			ev: "edit",
			sf: fx.harness.terminal.surface!,
			id: inputNode.id,
			from: 0,
			to: 0,
			text: "staging",
			cursor: 7,
			len: 0,
		});
		fx.toggle();
		expect(fx.harness.tui.getFocused()).toBe(fx.home);
		fx.toggle();
		const restored = fx.questionNodes(fx.first.id).find((n) => n.k === "input")!;
		fx.harness.event({ ev: "focus", sf: fx.harness.terminal.surface!, id: restored.id });
		fx.submit(fx.first.id);
		expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ target: "staging" });
		expect(fx.harness.tui.getFocused()).toBe(fx.home);
	} finally {
		fx.stop();
	}
});

test("forms arriving after expansion remain reachable when earlier questions are skipped", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.store.create({ ...input, title: "Later question" }, "later");
		fx.harness.flush();
		for (const id of [fx.first.id, fx.second.id]) {
			fx.action(fx.questionNodes(id).find((n) => n.k === "button" && n.p?.actions?.click === "cancel")!, "cancel");
		}
		expect(fx.harness.find((n) => n.k === "tabs")).toBeDefined();
		expect(fx.store.list().every((q) => q.status === "pending")).toBe(true);
	} finally {
		fx.stop();
	}
});

test("resizing recomputes the native question body's height bound", async () => {
	const fx = await fixture();
	const terminal = fx.harness.terminal;
	try {
		fx.toggle();
		expect(fx.harness.find((n) => n.p?.role === "async-ask.body")?.p).toMatchObject({ max: { h: "15lines" } });
		Object.defineProperty(terminal, "rows", { configurable: true, value: 12 });
		await fx.harness.render();
		expect(fx.harness.find((n) => n.p?.role === "async-ask.body")?.p).toMatchObject({ max: { h: "6lines" } });
	} finally {
		Reflect.deleteProperty(terminal, "rows");
		fx.stop();
	}
});

test("send failures stay visible and retry requires explicit confirmation", async () => {
	const fx = await fixture();
	const submit = fx.panel.actions.submit;
	fx.panel.actions.submit = (id, data, notes) => {
		submit(id, data, notes);
		fx.store.setDelivery(id, "failed");
		throw new Error("Synthetic delivery failure");
	};
	try {
		fx.toggle();
		fx.select(fx.first.id, "o0");
		fx.submit(fx.first.id);
		expect(fx.harness.find((n) => n.k === "tabs")?.p).toMatchObject({ active: "answered" });
		expect(JSON.stringify(fx.harness.doc())).toContain("Synthetic delivery failure");
		const retry = fx
			.questionNodes(fx.first.id)
			.find((n) => n.k === "button" && n.p?.actions?.click?.startsWith("retry:"))!;
		fx.action(retry, `retry:${fx.first.id}`);
		expect(fx.store.get(fx.first.id)?.delivery).toBe("failed");
		fx.action(fx.harness.find((n) => n.k === "button" && n.p?.actions?.click === "confirm")!, "confirm");
		expect(fx.store.get(fx.first.id)?.delivery).toBe("queued");
		expect(JSON.stringify(fx.harness.doc())).not.toContain("Synthetic delivery failure");
	} finally {
		fx.stop();
	}
});

test("retained forms cannot submit while hidden, and defaults are never sent by collapse", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.first.id, "o0");
		const form = fx.harness.tui.getFocused()!;
		fx.toggle();
		form.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
		fx.toggle();
		fx.tab("answered");
		form.handleNativeEvent?.({ type: "action", key: "", act: "submit", mods: [] });
		expect(fx.store.get(fx.first.id)?.status).toBe("pending");
	} finally {
		fx.stop();
	}
});

test("reopening starts a fresh skip pass without discarding drafts", async () => {
	const fx = await fixture();
	try {
		fx.toggle();
		fx.select(fx.first.id, "o1");
		for (const id of [fx.first.id, fx.second.id]) {
			fx.action(fx.questionNodes(id).find(n => n.k === "button" && n.p?.actions?.click === "cancel")!, "cancel");
		}
		expect(fx.harness.find(n => n.k === "tabs")).toBeUndefined();
		fx.toggle();
		fx.action(fx.questionNodes(fx.first.id).find(n => n.k === "button" && n.p?.actions?.click === "cancel")!, "cancel");
		expect(fx.harness.find(n => n.k === "tabs")).toBeDefined();
		fx.submit(fx.first.id);
		expect(fx.store.get(fx.first.id)?.answer?.data).toEqual({ format: "markdown" });
	} finally {
		fx.stop();
	}
});
