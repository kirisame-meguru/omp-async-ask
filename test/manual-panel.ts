import { Input, ProcessTerminal, TUI, type TerminalFrameProvider } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { col, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { QuestionPanel } from "../src/panel";
import { QuestionStore } from "../src/state";
import { input, journal } from "./helpers";

// Synthetic, standalone native acceptance surface: no model calls or production actions.
await initTheme(false);
const tui = new TUI(new ProcessTerminal());
const store = new QuestionStore("fixture", journal().append);
const html =
	'<form><fieldset><legend>Which test option do you prefer?</legend><label><input type="radio" name="option" value="a" checked>Option A</label><label><input type="radio" name="option" value="b">Option B</label></fieldset></form>';
store.create({ ...input, html }, "first");
store.create(
	{
		...input,
		title: "Export format",
		html: '<form><fieldset><legend>Which export format should I use?</legend><label><input type="radio" name="format" value="pdf">PDF</label><label><input type="radio" name="format" value="markdown">Markdown</label></fieldset></form>',
	},
	"second",
);
const composer = new Input();
let working = false;
const panel = new QuestionPanel(
	{
		questions: () => store.list(),
		errors: () => store.errors,
		subscribe: (fn) => store.subscribe(fn),
		submit: (id, data, notes) => {
			store.submit(id, data, notes);
			store.setDelivery(id, "recorded");
		},
		retry: (id) => store.setDelivery(id, "recorded"),
		close: () => {},
	},
	tui,
	process.cwd(),
);
const controls = {
	render: () => ["Native Questions acceptance fixture"],
	invalidate() {},
	describe: () =>
		row(
			[
				text("Native Questions acceptance fixture — synthetic data only"),
				node("button", { text: working ? "Set idle" : "Set working", actions: { click: "work" } }),
				node("button", { text: "Add question", actions: { click: "add" } }),
			],
			{ gap: "sm", wrap: true },
		),
	handleNativeEvent: (event: { type: string; act?: string }) => {
		if (event.type !== "action") return;
		if (event.act === "work") working = !working;
		if (event.act === "add") store.create({ ...input, html }, `extra-${store.list().length}`);
		tui.requestRender();
	},
};
const provider: TerminalFrameProvider & NativeSurfaceProvider = {
	renderFrame: () => ({ viewport: ["Native Questions acceptance fixture"] }),
	acknowledgeHistory() {},
	describeSurface: () => ({
		main: [controls],
		dock: [
			panel,
			...(working ? [text("Working…")] : []),
			col(
				[
					node("meter", { role: "omp.composer.context", value: 0.05, label: "5%", total: "272K", style: "bar" }),
					row([composer], { role: "omp.composer.line", gap: "sm" }),
					text("Message composer", { role: "omp.composer.bar", tone: "muted" }),
				],
				{ role: "omp.editor" },
			),
		],
		layer: [],
	}),
};
tui.setFrameProvider(provider);
tui.setFocus(composer);
process.once("SIGTERM", () => {
	panel.dispose();
	tui.stop();
	process.exit(0);
});
tui.start();
