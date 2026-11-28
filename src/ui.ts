import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import type { HtmlFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { defaultFormData } from "@oh-my-pi/pi-coding-agent/tools/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-coding-agent/tools/html-form/parse";
import { HtmlFormDialog, HtmlFormModel, formMedia } from "./form.generated.mjs";
import { nativeRendering, onCleanup, signal, UiNode, type JSXNode, type KeyEvent } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { AnswerNote, Question } from "./state";
import { AnsweredCard } from "./answered";

export interface InboxActions {
	questions(): readonly Question[];
	errors(): readonly string[];
	subscribe(listener: () => void): () => void;
	submit(id: string, data: HtmlFormData, notes: AnswerNote[]): void;
	retry(id: string): void;
	close(): void;
}

export function clean(value: string): string {
	return sanitizeText(value).replaceAll("\t", "    ");
}

export function questionStatus(label: string, tone: "muted" | "success" | "warning" | "error", icon?: string): UiNode {
	return new UiNode("row", { gap: "sm", align: "baseline", children: [
		new UiNode("icon", { name: icon ?? (tone === "success" ? "check" : tone === "error" ? "x" : tone === "warning" ? "warn" : "clock"), tone }),
		new UiNode("text", { role: "omp.ask.fold.answer", text: clean(label), tone, wrap: "word" }),
	] });
}

export function questionBlock(
	props: { role: string; title: string; target?: string; note?: string; status: "pending" | "done" | "error" | "cancelled"; collapsed?: boolean; preview?: { lines: number } | "children" },
	children: JSXNode,
	key?: string,
	onToggle?: (collapsed: boolean) => void,
): UiNode {
	return new UiNode("tool", { ...props, name: "ask", targetKind: "text", frame: "card",
		collapsible: props.collapsed !== undefined, children, onToggle }, key);
}

export function questionState(question: Question): string {
	if (question.status === "withdrawn") return "Withdrawn";
	if (question.status === "pending") return "Pending";
	return question.delivery === "failed" ? "Answered · send failed"
		: question.delivery === "unconfirmed" ? "Answered · delivery unconfirmed" : "Answered";
}

/** The host owns parsing, fields, notes, keyboard editing, validation hints and media. */
export class InboxForm {
	readonly model: HtmlFormModel;
	readonly #defaults: string;
	#disposed = false;
	constructor(
		readonly question: Question,
		readonly interactive: () => boolean,
		callbacks: { submit(data: HtmlFormData, notes: AnswerNote[]): void; skip(): void; release(): void; claim?(): void },
	) {
		const form = parseHtmlForm(question.html);
		this.#defaults = JSON.stringify(defaultFormData(form));
		this.model = new HtmlFormModel(form, {
			onSubmit: (data, notes) => { if (this.live) callbacks.submit(data, notes); },
			onCancel: () => { if (this.live) callbacks.skip(); },
			releaseKeys: () => { if (this.live) callbacks.release(); },
			claimKeys: () => { if (this.live) callbacks.claim?.(); },
		}, { focused: false, native: nativeRendering });
	}
	get live(): boolean { return !this.#disposed && this.interactive(); }
	givenAnswers(): boolean {
		return JSON.stringify(this.model.data()) !== this.#defaults || this.model.notes().length > 0 || Boolean(this.model.note()?.line.text);
	}
	view(host: ExtensionUiHost, cwd: string): JSXNode {
		return HtmlFormDialog({
			model: this.model, title: clean(this.question.title),
			terminalRows: () => host.size().rows, media: formMedia(this.model.form, cwd),
		});
	}
	key(key: KeyEvent): boolean { return this.live && this.model.key(key); }
	dispose(): void {
		this.#disposed = true;
		this.model.focused.set(false);
	}
}

export function QuestionIndicator(actions: InboxActions, open: () => void): UiNode {
	const revision = signal(0);
	onCleanup(actions.subscribe(() => revision.update(n => n + 1)));
	const counts = () => {
		revision();
		const questions = actions.questions();
		return { pending: questions.filter(q => q.status === "pending").length,
			failed: questions.filter(q => q.delivery === "failed").length, errors: actions.errors().length };
	};
	return new UiNode("button", {
		role: "omp.btn",
		text: () => { const c = counts(); return `Questions · ${c.pending} pending${c.failed ? ` · ${c.failed} send failed` : ""}${c.errors ? " · history error" : ""}`; },
		icon: () => counts().errors || counts().failed ? "warn" : "inbox",
		variant: () => counts().pending ? "primary" : "default",
		tone: () => counts().pending ? "accent" : "neutral",
		actions: { click: "open" }, onAction: () => open(),
		onKey: (key: KeyEvent) => { if (key.id !== "enter") return false; open(); return true; },
	});
}

/** User-opened overlay; incoming questions never open it or steal its current draft. */
export class QuestionInbox {
	#selected: string | undefined;
	#expanded: string | undefined;
	#tab: "pending" | "answered" = "pending";
	#remembered: Partial<Record<"pending" | "answered", string>> = {};
	#initialized = false;
	#hadPending = false;
	#submitting = false;
	#disposed = false;
	#forms = new Map<string, InboxForm>();
	#skipped = new Set<string>();
	#confirm: "discard" | "retry" | undefined;
	#message = "";
	readonly #revision = signal(0);
	readonly #unsubscribe: () => void;
	constructor(readonly actions: InboxActions, readonly host: ExtensionUiHost, readonly cwd = ".") {
		this.#unsubscribe = actions.subscribe(() => this.#sync());
		this.#sync();
	}
	get form(): InboxForm | undefined { return this.#expanded ? this.#forms.get(this.#expanded) : undefined; }
	debugState() { return { tab: this.#tab, selected: this.#selected, expanded: this.#expanded ?? null,
		form: this.form ? this.#expanded : null, skipped: [...this.#skipped], confirmation: this.#confirm ?? null }; }
	#visible() { return this.actions.questions().filter(q => this.#tab === "pending" ? q.status === "pending" : q.status !== "pending"); }
	#first(questions: readonly Question[]) {
		return (questions.find(q => q.delivery === "failed") ?? questions.find(q => q.delivery === "unconfirmed") ?? questions[0])?.id;
	}
	switchTab(tab: "pending" | "answered"): void {
		if (this.#disposed || this.#tab === tab) return;
		this.#remembered[this.#tab] = this.#expanded ?? this.#selected;
		this.expand(undefined);
		this.#tab = tab;
		this.#message = "";
		const questions = this.#visible();
		const remembered = this.#remembered[tab];
		this.expand(questions.some(q => q.id === remembered) ? remembered : this.#first(questions));
		this.#refresh();
	}
	#sync(autoClose = true): void {
		if (this.#disposed || this.#submitting) return;
		const questions = this.actions.questions();
		const pending = questions.some(q => q.status === "pending");
		const finished = this.#hadPending && !pending;
		this.#hadPending = pending;
		let advance: string | undefined;
		for (const [id, form] of this.#forms) {
			const current = questions.find(q => q.id === id);
			if (current?.status === "pending") continue;
			if (this.#expanded === id) {
				advance = id;
				this.#message = current?.status === "withdrawn" ? `Withdrawn: ${current.reason}` : "Answer submitted.";
			}
			form.dispose();
			this.#forms.delete(id);
			this.#skipped.delete(id);
		}
		if (finished && autoClose) { this.#finishClose(); return; }
		if (!this.#initialized && questions.length) {
			this.#initialized = true;
			this.#tab = pending ? "pending" : "answered";
			this.expand(this.#first(this.#visible()));
		} else if (advance) {
			this.#confirm = undefined;
			this.expand(this.#tab === "pending" ? this.#nextPending(advance) : this.#first(this.#visible()));
		} else if (this.#expanded && !this.#visible().some(q => q.id === this.#expanded)) this.expand(undefined);
		if (!this.#visible().some(q => q.id === this.#selected)) this.#selected = this.#visible()[0]?.id;
		this.#refresh();
	}
	#nextPending(after: string, includeSkipped = true): string | undefined {
		const questions = this.actions.questions();
		const index = questions.findIndex(q => q.id === after);
		for (let offset = 1; offset <= questions.length; offset++) {
			const q = questions[(index + offset) % questions.length]!;
			if (q.id !== after && q.status === "pending" && (includeSkipped || !this.#skipped.has(q.id))) return q.id;
		}
	}
	expand(id: string | undefined): void {
		if (this.#disposed || id === this.#expanded) return;
		if (this.form) { this.form.model.focused.set(false); this.#skipped.add(this.#expanded!); }
		this.#expanded = id;
		if (id) {
			this.#selected = id;
			this.#skipped.delete(id);
			const question = this.actions.questions().find(q => q.id === id);
			if (question?.status === "pending" && !this.actions.errors().length) {
				let form = this.#forms.get(id);
				if (!form) {
					form = new InboxForm(question,
						() => !this.#disposed && !this.#confirm && this.#expanded === id && !this.actions.errors().length
							&& this.actions.questions().some(q => q.id === id && q.status === "pending"),
						{ submit: (data, notes) => {
							this.#submitting = true;
							let failure: string | undefined;
							try { this.actions.submit(id, data, notes); }
							catch (error) { failure = String(error); }
							finally { this.#submitting = false; }
							this.#sync(failure === undefined);
							if (failure !== undefined) {
								if (this.actions.questions().some(q => q.id === id && q.status === "answered")) {
									this.switchTab("answered");
									this.expand(id);
								}
								this.#message = failure;
								this.#refresh();
							}
						}, skip: () => this.skip(), release: () => this.expand(undefined) });
					this.#forms.set(id, form);
				}
				form.model.focused.set(true);
			}
		}
		this.#refresh();
	}
	skip(): void {
		if (!this.form || !this.#expanded) return;
		const previous = this.#expanded;
		this.#skipped.add(previous);
		this.expand(this.#nextPending(previous, false));
	}
	#finishClose(): void { if (!this.#disposed) { this.dispose(); this.actions.close(); } }
	close(): void {
		if (this.#disposed) return;
		if ([...this.#forms.values()].some(form => form.givenAnswers())) {
			this.#confirm = "discard";
			this.form?.model.focused.set(false);
			this.#refresh();
		} else this.#finishClose();
	}
	confirm(): void {
		if (this.#disposed) return;
		if (this.#confirm === "discard") { this.#finishClose(); return; }
		if (this.#confirm === "retry" && this.#expanded) {
			this.#confirm = undefined;
			try { this.actions.retry(this.#expanded); } catch (error) { this.#message = String(error); }
		}
		this.#sync();
	}
	keep(): void { this.#confirm = undefined; this.form?.model.focused.set(true); this.#refresh(); }
	retry(): void {
		if (this.actions.questions().some(q => q.id === this.#expanded && (q.delivery === "failed" || q.delivery === "unconfirmed"))) {
			this.#confirm = "retry";
			this.#refresh();
		}
	}
	key(key: KeyEvent): boolean {
		if (this.#disposed || key.kind === "release") return false;
		if (this.#confirm) {
			if (key.id === "enter") this.confirm();
			else if (key.id === "escape") this.keep();
		} else if (key.id === "ctrl+left" || key.id === "ctrl+right") {
			this.switchTab(this.#tab === "pending" ? "answered" : "pending");
		} else if (key.id === "ctrl+down" || key.id === "ctrl+up") {
			const questions = this.#visible();
			const index = questions.findIndex(q => q.id === this.#selected);
			this.expand(questions[Math.max(0, Math.min(questions.length - 1, index + (key.id === "ctrl+up" ? -1 : 1)))]?.id);
		} else if (this.form) return this.form.key(key);
		else if (key.id === "escape") this.close();
		else if (key.id === "r") this.retry();
		else if (key.id === "enter") this.expand(this.#expanded === this.#selected ? undefined : this.#selected);
		else if (key.id === "up" || key.id === "down") {
			const questions = this.#visible();
			const index = questions.findIndex(q => q.id === this.#selected);
			this.#selected = questions[Math.max(0, Math.min(questions.length - 1, index + (key.id === "up" ? -1 : 1)))]?.id;
		} else return false;
		this.#refresh();
		return true;
	}
	view(): UiNode {
		onCleanup(() => this.dispose());
		return new UiNode("col", {
			role: "async-ask.inbox", gap: "md", onKey: (key: KeyEvent) => this.key(key),
			onPaste: (paste: { text: string }) => { if (!this.form?.live) return false; this.form.model.paste(paste.text); return true; },
			children: () => {
				this.#revision();
				const questions = this.actions.questions();
				const pending = questions.filter(q => q.status === "pending").length;
				return [
					new UiNode("row", { gap: "md", justify: "between", children: [
						new UiNode("tabs", { items: [{ id: "pending", label: `Pending (${pending})` }, { id: "answered", label: `Answered (${questions.length - pending})` }],
							active: this.#tab, onSelect: (tab: string) => { if (tab === "pending" || tab === "answered") this.switchTab(tab); } }),
						new UiNode("button", { text: "Close", actions: { click: "close" }, onAction: () => this.close() }),
					] }),
					...(this.#confirm ? [
						questionStatus(this.#confirm === "discard" ? "Close and discard unsent drafts? Questions remain pending." : "Delivery is unconfirmed. Retrying may deliver the answer twice.", "warning"),
						new UiNode("row", { gap: "sm", children: [
							new UiNode("button", { text: this.#confirm === "discard" ? "Discard drafts and close" : "Retry answer", actions: { click: "confirm" }, onAction: () => this.confirm() }),
							new UiNode("button", { text: "Keep current state", actions: { click: "keep" }, onAction: () => this.keep() }),
						] }),
					] : this.#visible().length ? this.#visible().map(q => this.#card(q)) : [new UiNode("text", { role: "omp.ask.fold.answer", text: this.#tab === "pending" ? "No pending questions." : "No answered questions yet." })]),
					...(this.#message ? [questionStatus(this.#message, "warning")] : []),
					...this.actions.errors().map(error => questionStatus(error, "error")),
				];
			},
		});
	}
	#card(question: Question): UiNode {
		const expanded = question.id === this.#expanded;
		const form = this.#forms.get(question.id);
		return questionBlock({ role: "async-ask.question", title: "Question", target: clean(question.title),
			note: this.#skipped.has(question.id) ? "Skipped · still pending" : questionState(question),
			status: question.delivery === "failed" ? "error" : question.status === "answered" ? "done" : question.status === "withdrawn" ? "cancelled" : "pending",
			collapsed: !expanded }, expanded ? [
				...(form ? [form.view(this.host, this.cwd)] : [AnsweredCard(question, true, () => {})]),
				...((question.delivery === "failed" || question.delivery === "unconfirmed") ? [new UiNode("button", {
					text: "Review resend…", actions: { click: "retry" }, onAction: () => this.retry(),
				})] : []),
			] : [], question.id, collapsed => this.expand(collapsed ? undefined : question.id));
	}
	#refresh(): void { this.#revision.update(n => n + 1); }
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#unsubscribe();
		for (const form of this.#forms.values()) form.dispose();
		this.#forms.clear();
	}
}
