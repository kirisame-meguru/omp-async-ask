import { createSurface, signal, startHost, UiNode, type Host, type JSXNode } from "@oh-my-pi/pi-tui";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui/driver/session";
import type { CustomMessagePayload, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { isRecord } from "@oh-my-pi/pi-utils";
import { QuestionAttention } from "../src/attention";
import { AnswerDelivery } from "../src/delivery";
import { QuestionStore } from "../src/state";
import { type InboxActions, QuestionInbox, QuestionIndicator } from "../src/ui";
import { input, journal, recordedEntry } from "./helpers";

const log = journal();
const store = new QuestionStore("fixture", log.append);
const attention = new QuestionAttention(store);
const queued: CustomMessagePayload[] = [];
const delivery = new AnswerDelivery(store, {
	sessionId: () => "fixture", isIdle: () => false, entries: () => log.entries,
	send: message => { queued.push(message); },
});
store.create(input, "first");
store.create({ ...input, title: "Retention policy", blockedWork: "Final retention configuration",
	html: '<form><fieldset><legend>Retention period</legend><label><input type="radio" name="days" value="7" checked>Seven days</label><label><input type="radio" name="days" value="30">Thirty days</label></fieldset></form>',
}, "second");
store.create({ ...input, title: "Release notes", blockedWork: "Preparing the release announcement",
	html: '<form><label>Anything to highlight?<textarea name="notes"></textarea></label></form>',
}, "third");
const steps = signal(0);
const result = signal("No user answer has been submitted.");
const layer = signal<JSXNode>(undefined);
let inbox: QuestionInbox | undefined;
let host: Host | undefined;
const ui: ExtensionUiHost = {
	size: () => ({ columns: host?.driver.columns ?? 100, rows: host?.driver.rows ?? 30 }),
	requestRender: () => {},
	suspend: run => host!.suspend(run),
};
const actions: InboxActions = {
	questions: () => store.list(), errors: () => store.errors, subscribe: listener => store.subscribe(listener),
	submit: (id, data, notes) => delivery.submit(id, data, notes), retry: id => delivery.retry(id),
	close: () => { inbox?.dispose(); inbox = undefined; layer.set(undefined); surface.focus(home); },
};
function open(): void {
	if (inbox) return;
	layer.set(() => {
		inbox = new QuestionInbox(actions, ui, process.cwd());
		const node = inbox.view();
		surface.focus(node);
		return new UiNode("overlay", { head: "Questions", children: node });
	});
}
let home!: UiNode;
const surface = createSurface(() => ({
	main: [
		new UiNode("text", { text: "Async Ask acceptance fixture — synthetic data; no model calls" }),
		new UiNode("text", { text: () => `Independent work steps: ${steps()}` }),
		new UiNode("text", { text: result }),
	],
	dock: [
		QuestionIndicator(actions, open),
		home = new UiNode("text", { text: "i opens Questions; q quits. Work continues while forms are open.",
			onKey: (key: { id: string }) => {
				if (key.id === "i") { open(); return true; }
				if (key.id === "q" || key.id === "ctrl+c") { void stop(); return true; }
				return false;
			},
		}),
	],
	layer,
}));
surface.focus(home);
host = await startHost({ surface, theme: currentTheme, title: "Async Ask acceptance" });
const timer = setInterval(() => {
	steps.update(n => n + 1);
	if (steps() === 4) writeTerminalSequence("\x1b]7501;state=done:app=omp\x1b\\");
	for (const payload of queued.splice(0)) {
		if (typeof payload === "string" || !isRecord(payload.details) || typeof payload.details.requestId !== "string") continue;
		const question = store.get(payload.details.requestId);
		if (!question?.answer || question.answer.id !== payload.details.answerId) continue;
		log.entries.push({ ...recordedEntry("fixture", question.id, question.answer.id), parentId: log.entries.at(-1)?.id ?? null });
		delivery.settle();
		result.set(`Recorded answer: ${JSON.stringify(question.answer.data)} at step ${steps()}`);
	}
}, 500);
async function stop(): Promise<void> {
	clearInterval(timer);
	delivery.dispose();
	attention.dispose();
	inbox?.dispose();
	writeTerminalSequence("\x1b]7501;state=clear\x1b\\");
	await host?.stop();
	surface.dispose();
}
process.once("SIGTERM", () => void stop());
writeTerminalSequence("\x1b]7501;state=working:app=omp\x1b\\");
