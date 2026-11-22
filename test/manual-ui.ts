import { type Component, matchesKey, ProcessTerminal, Text, TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { CustomMessagePayload } from "@oh-my-pi/pi-coding-agent";
import { text } from "@oh-my-pi/pi-tui/native/describe";
import { isRecord } from "@oh-my-pi/pi-utils";
import { AnswerDelivery } from "../src/delivery";
import { QuestionStore } from "../src/state";
import { type InboxActions, QuestionInbox, QuestionIndicator } from "../src/ui";
import { input, journal, recorded } from "./helpers";

await initTheme(false);
const tui = new TUI(new ProcessTerminal());
const log = journal();
const store = new QuestionStore("fixture", log.append);
const queued: CustomMessagePayload[] = [];
const delivery = new AnswerDelivery(store, {
	sessionId: () => "fixture",
	isIdle: () => false,
	entries: () => log.entries,
	send: message => {
		queued.push(message);
	},
});
store.create(input, "first");
store.create(
	{
		...input,
		title: "Retention policy",
		blockedWork: "Final retention configuration",
		html: '<form><fieldset><legend>Retention period</legend><label><input type="radio" name="days" value="7" checked>Seven days</label><label><input type="radio" name="days" value="30">Thirty days</label></fieldset></form>',
	},
	"second",
);
store.create(
	{
		...input,
		title: "Release notes",
		blockedWork: "Preparing the release announcement",
		html: '<form><label>Anything to highlight?<textarea name="notes" placeholder="Optional context for the release"></textarea></label></form>',
	},
	"third",
);
const title = new Text("Async Ask acceptance fixture — no model requests or production actions", 0, 0);
const work = new Text("Independent work steps: 0", 0, 0);
const result = new Text("No user answer has been submitted.", 0, 0);
let closeOverlay: (() => void) | undefined;
let inbox: QuestionInbox | undefined;
const actions: InboxActions = {
	questions: () => store.list(),
	errors: () => store.errors,
	subscribe: callback => store.subscribe(callback),
	submit: (id, data, notes) => delivery.submit(id, data, notes),
	retry: id => delivery.retry(id),
	close: () => {
		closeOverlay?.();
		closeOverlay = undefined;
		inbox?.dispose();
		inbox = undefined;
		tui.setFocus(home);
	},
};
function open(): void {
	if (inbox) return;
	inbox = new QuestionInbox(actions, tui, process.cwd());
	const handle = tui.showOverlay(inbox, { width: "90%", maxHeight: "90%" });
	closeOverlay = () => handle.hide();
}
const indicator = new QuestionIndicator(actions, open, tui);
const homeHelp = "Press i to open Questions; q to quit. Work continues while forms are open.";
const home: Component = {
	render: () => [homeHelp],
	describe: () => text(homeHelp),
	handleInput: data => {
		if (data === "i") open();
		if (data === "q" || matchesKey(data, "ctrl+c")) stop();
	},
	invalidate() {},
};
tui.addChild(title);
tui.addChild(work);
tui.addChild(result);
tui.addChild(indicator);
tui.addChild(home);
tui.setFocus(home);
let steps = 0;
const timer = setInterval(() => {
	work.setText(`Independent work steps: ${++steps}`);
	for (const payload of queued.splice(0)) {
		if (typeof payload === "string" || !isRecord(payload.details) || typeof payload.details.requestId !== "string")
			continue;
		const question = store.get(payload.details.requestId);
		if (!question?.answer || question.answer.id !== payload.details.answerId) continue;
		const message = recorded("fixture", question.id, question.answer.id);
		log.entries.push({
			type: "message",
			id: crypto.randomUUID(),
			parentId: log.entries.at(-1)?.id ?? null,
			timestamp: new Date().toISOString(),
			message,
		});
		delivery.observe(message);
		result.setText(`Recorded answer: ${JSON.stringify(question.answer.data)} at independent work step ${steps}`);
	}
	tui.requestRender();
}, 500);
function stop(): void {
	clearInterval(timer);
	delivery.dispose();
	inbox?.dispose();
	indicator.dispose();
	tui.stop();
	process.exit(0);
}
process.once("SIGTERM", stop);
tui.start();
