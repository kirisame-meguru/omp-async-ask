import { createSurface, signal, startHost, UiNode, type Host, type KeyEvent } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { QuestionPanel } from "../src/panel";
import { QuestionStore } from "../src/state";
import { input, journal } from "./helpers";

const store = new QuestionStore("fixture", journal().append);
const html = '<form><fieldset><legend>Which test option?</legend><label><input type="radio" name="option" value="a" checked>Option A</label><label><input type="radio" name="option" value="b">Option B</label></fieldset></form>';
store.create({ ...input, html }, "first");
store.create({ ...input, html, title: "Second question" }, "second");
const working = signal(false);
const draft = signal("");
let host: Host | undefined;
let panel!: QuestionPanel;
let composer!: UiNode;
let claim: ((key: KeyEvent) => boolean) | undefined;
const ui: ExtensionUiHost = {
	size: () => ({ columns: host?.driver.columns ?? 100, rows: host?.driver.rows ?? 30 }),
	requestRender: () => {},
	suspend: run => host!.suspend(run),
};
const surface = createSurface(() => {
	panel = new QuestionPanel({
		questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
		submit: (id, data, notes) => { store.submit(id, data, notes); store.setDelivery(id, "recorded"); },
		retry: id => store.setDelivery(id, "recorded"), close: () => {},
	}, ui, process.cwd(), handler => { claim = handler; return () => { claim = undefined; }; });
	composer = new UiNode("input", { text: draft, cursor: () => draft().length,
		onEdit: (edit: { from: number; to: number; text: string }) => draft.set(draft().slice(0, edit.from) + edit.text + draft().slice(edit.to)),
		onKey: (key: KeyEvent) => {
			if (claim?.(key)) return true;
			if (key.id === "ctrl+c") { void stop(); return true; }
			if (key.id === "ctrl+i") { panel.open(); return true; }
			return false;
		},
	});
	return {
		main: new UiNode("row", { gap: "sm", children: [
			new UiNode("text", { text: "Native Questions acceptance — synthetic data only" }),
			new UiNode("button", { text: () => working() ? "Set idle" : "Set working", actions: { click: "work" }, onAction: () => working.update(value => !value) }),
			new UiNode("button", { text: "Add question", actions: { click: "add" }, onAction: () => store.create({ ...input, html }, `extra-${store.list().length}`) }),
		] }),
		dock: [panel.view(), () => working() ? new UiNode("text", { text: "Working…" }) : undefined, composer],
	};
});
surface.focus(composer);
host = await startHost({ surface, theme: currentTheme, title: "Async Ask panel acceptance" });
async function stop(): Promise<void> {
	panel.dispose();
	await host?.stop();
	surface.dispose();
}
process.once("SIGTERM", () => void stop());
