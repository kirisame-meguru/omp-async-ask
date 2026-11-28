import type { ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { onCleanup, signal, UiNode, type JSXNode, type KeyEvent } from "@oh-my-pi/pi-tui";
import { defineRolePainter, painterFor } from "@oh-my-pi/pi-tui/term/paint";
import "@oh-my-pi/pi-tui/term/painters/layout";
import type { Question } from "./state";
import { AnsweredCard } from "./answered";
import { clean, InboxForm, questionBlock, questionStatus, type InboxActions } from "./ui";

// Keep the plain-terminal column fallback until OMP includes Tern's scroll kind.
defineRolePainter("scroll" as "col", "async-ask.body", painterFor(new UiNode("col", {}))!);

/** Session-owned disclosure. Opening never takes keys from the composer. */
export class QuestionPanel {
	#expanded = false;
	#hadPending: boolean;
	#foldedAnswers = new Set<string>();
	#tab: "pending" | "answered" = "pending";
	#forms = new Map<string, InboxForm>();
	#skipped = new Set<string>();
	#claimed: string | undefined;
	#retry: string | undefined;
	#message = "";
	#disposed = false;
	#submitting = false;
	#scrollVersion = 0;
	readonly #revision = signal(0);
	readonly #unsubscribe: () => void;
	readonly #unsubscribeKeys: (() => void) | undefined;
	constructor(
		readonly actions: InboxActions,
		readonly host: ExtensionUiHost,
		readonly cwd = ".",
		addKeyHandler?: (handler: (key: KeyEvent) => boolean) => () => void,
	) {
		this.#hadPending = actions.questions().some(q => q.status === "pending");
		this.#unsubscribe = actions.subscribe(() => this.#sync());
		this.#unsubscribeKeys = addKeyHandler?.(key => this.key(key));
	}
	open(): void {
		if (this.#disposed || this.#expanded) return;
		this.#expanded = true;
		this.#skipped.clear();
		this.#scrollVersion++;
		this.#tab = this.actions.questions().some(q => q.status === "pending") ? "pending" : "answered";
		this.#sync();
	}
	collapse(): void {
		this.release();
		this.#expanded = false;
		this.#retry = undefined;
		this.#revision.update(n => n + 1);
	}
	claim(id: string): void {
		const form = this.#forms.get(id);
		if (!form?.live) return;
		this.release();
		this.#claimed = id;
		form.model.focused.set(true);
	}
	release(): void {
		if (this.#claimed) this.#forms.get(this.#claimed)?.model.focused.set(false);
		this.#claimed = undefined;
	}
	key(key: KeyEvent): boolean {
		if (this.#disposed || key.kind === "release" || !this.#claimed) return false;
		const form = this.#forms.get(this.#claimed);
		if (!form?.live) { this.release(); return false; }
		return form.key(key);
	}
	switchTab(tab: "pending" | "answered"): void {
		if (this.#disposed || !this.#expanded) return;
		this.release();
		this.#tab = tab;
		this.#scrollVersion++;
		this.#retry = undefined;
		this.#revision.update(n => n + 1);
	}
	form(id: string): InboxForm | undefined { return this.#forms.get(id); }
	#sync(keepOpen = false): void {
		if (this.#disposed || this.#submitting) return;
		const questions = this.actions.questions();
		const pending = questions.some(q => q.status === "pending");
		if (this.#hadPending && !pending && !keepOpen) {
			this.release();
			this.#expanded = false;
			this.#retry = undefined;
		}
		this.#hadPending = pending;
		for (const [id, form] of this.#forms) {
			if (questions.some(q => q.id === id && q.status === "pending")) continue;
			if (this.#claimed === id) this.release();
			form.dispose();
			this.#forms.delete(id);
			this.#skipped.delete(id);
		}
		if (this.#retry && !questions.some(q => q.id === this.#retry && (q.delivery === "failed" || q.delivery === "unconfirmed"))) this.#retry = undefined;
		if (this.#expanded && !this.actions.errors().length) {
			for (const question of questions) {
				if (question.status !== "pending" || this.#forms.has(question.id)) continue;
				const interactive = () => !this.#disposed && this.#expanded && this.#tab === "pending" && !this.#retry
					&& !this.actions.errors().length && this.actions.questions().some(q => q.id === question.id && q.status === "pending");
				this.#forms.set(question.id, new InboxForm(question, interactive, {
					claim: () => this.claim(question.id),
					release: () => this.release(),
					skip: () => {
						this.#skipped.add(question.id);
						this.release();
						const next = this.actions.questions().find(q => q.status === "pending" && !this.#skipped.has(q.id) && this.#forms.has(q.id));
						if (next) this.claim(next.id);
						else this.collapse();
						this.#revision.update(n => n + 1);
					},
					submit: (data, notes) => {
						this.#submitting = true;
						this.#message = "";
						let failed = false;
						try { this.actions.submit(question.id, data, notes); }
						catch (error) {
							failed = true;
							this.#message = String(error);
							if (this.actions.questions().some(q => q.id === question.id && q.status === "answered")) this.#tab = "answered";
						} finally {
							this.release();
							this.#submitting = false;
							this.#sync(failed);
						}
					},
				}));
			}
		}
		if (this.actions.errors().length) this.release();
		this.#revision.update(n => n + 1);
	}
	retry(id: string): void {
		if (this.#disposed || !this.#expanded || this.#tab !== "answered") return;
		if (!this.actions.questions().some(q => q.id === id && (q.delivery === "failed" || q.delivery === "unconfirmed"))) return;
		this.release();
		this.#retry = id;
		this.#revision.update(n => n + 1);
	}
	confirm(): void {
		if (!this.#retry || this.#disposed) return;
		const id = this.#retry;
		this.#retry = undefined;
		this.#message = "";
		try { this.actions.retry(id); } catch (error) { this.#message = String(error); }
		this.#revision.update(n => n + 1);
	}
	keep(): void { this.#retry = undefined; this.#revision.update(n => n + 1); }
	#question(question: Question): UiNode {
		const form = this.#forms.get(question.id);
		if (question.status !== "pending" || !form) {
			const open = !this.#foldedAnswers.has(question.id);
			return new UiNode("section", { role: "async-ask.question", children: [AnsweredCard(question, open, next => {
				if (next) this.#foldedAnswers.delete(question.id); else this.#foldedAnswers.add(question.id);
				this.#revision.update(n => n + 1);
			}, () => this.retry(question.id))] }, question.id);
		}
		return new UiNode("section", { role: "async-ask.question", head: clean(question.title), children: [form.view(this.host, this.cwd)] }, question.id);
	}
	view(): UiNode {
		onCleanup(() => this.dispose());
		return new UiNode("col", { role: "async-ask.dock", gap: "sm", children: () => {
			this.#revision();
			const questions = this.actions.questions();
			const pending = questions.filter(q => q.status === "pending").length;
			if (!pending && !this.#expanded) return [];
			const failed = questions.filter(q => q.delivery === "failed").length;
			const body: JSXNode[] = [];
			if (this.#expanded) {
				body.push(new UiNode("tabs", {
					items: [{ id: "pending", label: `Pending (${pending})` }, { id: "answered", label: `Answered (${questions.length - pending})` }],
					active: this.#tab, variant: "underline",
					onSelect: (tab: string) => { if (tab === "pending" || tab === "answered") this.switchTab(tab); },
				}));
				const visible = this.#tab === "pending" ? questions.filter(q => q.status === "pending") : questions.filter(q => q.status !== "pending").reverse();
				// shortcut: OMP's kind union lacks Tern's scroll container; remove the cast when it catches up.
				body.push(new UiNode("scroll" as "col", {
					// Bound only so very long inboxes scroll; keep just the prompt and status rows visible below.
					role: "async-ask.body", gap: "sm", max: () => ({ h: `${Math.max(6, this.host.size().rows - 4)}lines` }),
					scroll: { by: "start", n: this.#scrollVersion },
					children: [
						...(this.#retry ? [
							questionStatus("Delivery is unconfirmed. Retrying may deliver the answer twice.", "warning"),
							new UiNode("row", { gap: "sm", children: [
								new UiNode("button", { text: "Retry answer", actions: { click: "confirm" }, onAction: () => this.confirm() }),
								new UiNode("button", { text: "Keep current state", actions: { click: "keep" }, onAction: () => this.keep() }),
							] }),
						] : visible.length ? visible.map(q => this.#question(q)) : [new UiNode("text", { role: "omp.ask.fold.answer", text: this.#tab === "pending" ? "No pending questions." : "No answered questions yet." })]),
						...(this.#message ? [questionStatus(this.#message, "warning")] : []),
						...this.actions.errors().map(error => questionStatus(error, "error")),
					],
				}));
			}
			return [
				questionBlock({ role: "async-ask.panel", title: "Questions",
					target: failed ? `${failed} send failed` : this.actions.errors().length ? "History error" : undefined,
					status: failed || this.actions.errors().length ? "error" : pending ? "pending" : "done",
					collapsed: !this.#expanded, preview: { lines: 0 } }, body, "panel", collapsed => collapsed ? this.collapse() : this.open()),
				new UiNode("spacer", { role: "async-ask.clearance", size: "none", min: { h: "1lines" }, shrink: 0 }),
			];
		} });
	}
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.release();
		this.#unsubscribe();
		this.#unsubscribeKeys?.();
		for (const form of this.#forms.values()) form.dispose();
		this.#forms.clear();
	}
}
