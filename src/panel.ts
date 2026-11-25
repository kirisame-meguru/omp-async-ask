import type { Component, TUI } from "@oh-my-pi/pi-tui";
import type { HtmlFormDialogOptions, HtmlFormHost } from "@oh-my-pi/pi-tui/html-form/dialog";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { col, elapsed, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import type { Question } from "./state";
import { applyQuestionStyles, InboxForm, questionBlock, questionStatus, type InboxActions } from "./ui";

export interface PanelHost extends HtmlFormHost, Pick<TUI, "getFocused" | "setFocus"> {}

/** Detached drafts keep values, not permission to interact with hidden or withdrawn forms. */
class PanelForm extends InboxForm {
	#description: NativeNode | undefined;
	constructor(
		html: string,
		options: HtmlFormDialogOptions,
		readonly interactive: () => boolean,
	) {
		super(parseHtmlForm(html), options);
	}
	override describe(context: DescribeContext): NativeNode {
		return (this.#description = super.describe(context));
	}
	owns(component: Component | null): boolean {
		if (component === this) return true;
		if (!component || !this.#description) return false;
		const contains = (child: NativeChild): boolean =>
			child === component || ("k" in child && (child.c?.some(contains) ?? false));
		return contains(this.#description);
	}
	override handleNativeEvent(event: NativeUiEvent): void {
		if (this.interactive()) super.handleNativeEvent(event);
	}
	override handleInput(data: string): void {
		if (this.interactive()) super.handleInput(data);
	}
}

/** Session-owned disclosure: no overlay, no automatic focus, no draft disposal on collapse. */
export class QuestionPanel implements Component {
	#expanded = false;
	#hadPending: boolean;
	#tab: "pending" | "answered" = "pending";
	#forms = new Map<string, PanelForm>();
	#skipped = new Set<string>();
	#returnFocus: Component | null = null;
	#retry: string | undefined;
	#message = "";
	#disposed = false;
	#submitting = false;
	#unsubscribe: () => void;
	#rows = 0;
	#scrollVersion = 0;
	#native: NativeNode | undefined;
	#styled = false;

	constructor(
		readonly actions: InboxActions,
		readonly host: PanelHost,
		readonly cwd?: string,
	) {
		this.#hadPending = actions.questions().some((q) => q.status === "pending");
		this.#unsubscribe = actions.subscribe(() => this.#sync());
	}

	open(): void {
		if (this.#disposed || this.#expanded) return;
		this.#expanded = true;
		this.#skipped.clear();
		this.#returnFocus = this.host.getFocused();
		this.#scrollVersion++;
		this.#tab = this.actions.questions().some((q) => q.status === "pending") ? "pending" : "answered";
		this.#sync();
	}

	#collapse(): void {
		this.#releaseKeys();
		this.#expanded = false;
		this.#retry = undefined;
		this.#refresh();
	}

	#claimKeys(form: PanelForm): void {
		const current = this.host.getFocused();
		if (current === form) return;
		if (!this.#ownsFocus(current)) this.#returnFocus = current;
		this.host.setFocus(form);
	}

	#ownsFocus(component: Component | null): boolean {
		for (const form of this.#forms.values()) {
			if (form.owns(component)) return true;
		}
		return false;
	}

	#releaseKeys(): void {
		if (this.#ownsFocus(this.host.getFocused())) this.host.setFocus(this.#returnFocus);
	}

	#sync(): void {
		if (this.#disposed || this.#submitting) return;
		const questions = this.actions.questions();
		const pending = questions.some((q) => q.status === "pending");
		if (this.#hadPending && !pending) {
			this.#releaseKeys();
			this.#expanded = false;
			this.#retry = undefined;
		}
		this.#hadPending = pending;
		for (const [id, form] of this.#forms) {
			if (questions.some((q) => q.id === id && q.status === "pending")) continue;
			if (form.owns(this.host.getFocused())) this.#releaseKeys();
			form.dispose();
			this.#forms.delete(id);
			this.#skipped.delete(id);
		}
		if (
			this.#retry &&
			!questions.some((q) => q.id === this.#retry && (q.delivery === "failed" || q.delivery === "unconfirmed"))
		) {
			this.#retry = undefined;
		}
		if (this.#expanded && !this.actions.errors().length) {
			for (const question of questions) {
				if (question.status !== "pending" || this.#forms.has(question.id)) continue;
				const interactive = () =>
					!this.#disposed &&
					this.#expanded &&
					this.#tab === "pending" &&
					!this.#retry &&
					!this.actions.errors().length &&
					this.actions.questions().some((q) => q.id === question.id && q.status === "pending");
				const form: PanelForm = new PanelForm(
					question.html,
					{
						title: sanitizeText(question.title),
						tui: this.host,
						cwd: this.cwd,
						acceptImages: false,
						claimKeys: () => this.#claimKeys(form),
						releaseKeys: () => this.#releaseKeys(),
						onCancel: () => {
							if (!interactive()) return;
							this.#skipped.add(question.id);
							this.#releaseKeys();
							const next = this.actions
								.questions()
								.find((q) => q.status === "pending" && !this.#skipped.has(q.id) && this.#forms.has(q.id));
							if (next) this.#claimKeys(this.#forms.get(next.id)!);
							else this.#collapse();
						},
						onSubmit: (data, notes) => {
							if (!interactive()) return;
							this.#submitting = true;
							this.#message = "";
							try {
								this.actions.submit(question.id, data, notes);
							} catch (error) {
								this.#message = String(error);
								if (this.actions.questions().find((q) => q.id === question.id)?.status === "answered") {
									this.#releaseKeys();
									this.#tab = "answered";
								}
							} finally {
								this.#submitting = false;
								this.#sync();
							}
						},
					},
					interactive,
				);
				this.#forms.set(question.id, form);
			}
		}
		this.#refresh();
		logger.debug("Async Ask panel synchronized", {
			pending: questions.filter(question => question.status === "pending").length,
			expanded: this.#expanded,
		});
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "toggle" && (event.key === "panel" || event.key.endsWith("/panel"))) {
			if (event.collapsed) this.#collapse();
			else this.open();
			return;
		}
		if (!this.#expanded) return;
		if ((event.type === "select" || event.type === "activate") && event.key.endsWith("inbox-tabs")) {
			if (event.item !== "pending" && event.item !== "answered") return;
			this.#releaseKeys();
			this.#tab = event.item;
			this.#scrollVersion++;
			this.#retry = undefined;
		} else if (event.type === "action") {
			if (event.act.startsWith("retry:")) {
				const id = event.act.slice(6);
				if (
					this.#tab === "answered" &&
					this.actions.questions().some((q) => q.id === id && (q.delivery === "unconfirmed" || q.delivery === "failed"))
				) {
					this.#releaseKeys();
					this.#retry = id;
				}
			} else if (event.act === "keep") this.#retry = undefined;
			else if (event.act === "confirm" && this.#retry) {
				const id = this.#retry;
				this.#retry = undefined;
				this.#message = "";
				try {
					this.actions.retry(id);
				} catch (error) {
					this.#message = String(error);
				}
			}
		}
		this.#refresh();
	}

	#question(question: Question): NativeNode {
		const body: NativeChild[] = [
			row([
				questionStatus(
					this.#skipped.has(question.id) ? "Skipped · still pending"
						: question.delivery === "failed" ? "Answered · send failed"
						: question.delivery === "unconfirmed" ? "Answered · delivery unconfirmed"
						: question.status === "pending" ? "Awaiting answer"
						: question.status === "withdrawn" ? "Withdrawn" : "Answered",
					question.delivery === "failed" || question.delivery === "unconfirmed" ? "warning"
						: question.status === "answered" ? "success" : "muted",
				),
				row([text("Asked", { tone: "muted" }), elapsed(Date.now() - question.createdAt)], { gap: "sm" }),
			], { gap: "sm", justify: "between", wrap: true }),
			text(sanitizeText(question.blockedWork), { tone: "muted", wrap: "word" }),
		];
		if (question.status === "pending") {
			const form = this.#forms.get(question.id);
			if (form) body.push(form);
		} else {
			if (question.reason) body.push(text(sanitizeText(question.reason), { tone: "muted", wrap: "word" }));
			if (question.answer) {
				body.push(
					node("kv", {
						items: Object.entries(question.answer.data).map(([k, v]) => ({
							k: sanitizeText(k),
							v: sanitizeText(Array.isArray(v) ? v.join(", ") : String(v)),
						})),
					}),
				);
				body.push(
					...question.answer.notes.map((note) =>
						text(sanitizeText(`${note.question} — ${note.option}: ${note.text}`), { wrap: "word" }),
					),
				);
			}
			if (question.delivery === "failed" || question.delivery === "unconfirmed") {
				body.push(
					text(
						question.delivery === "failed"
							? "Your answer is saved, but sending failed."
							: "Answer saved. No delivery receipt is available.",
						{ tone: "warning", wrap: "word" },
					),
				);
				body.push(
					node("button", { role: "omp.btn", text: "Review resend…", icon: "repeat", actions: { click: `retry:${question.id}` } }),
				);
			}
		}
		return node("section", { role: "async-ask.question", head: sanitizeText(question.title) }, body, question.id);
	}

	describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		if (this.#native && this.#rows === this.host.terminal.rows) return this.#native;
		this.#rows = this.host.terminal.rows;
		const questions = this.actions.questions();
		const pending = questions.filter((q) => q.status === "pending").length;
		if (!pending && !this.#expanded) return (this.#native = col([], { hidden: true }));
		const answered = questions.filter((q) => q.status !== "pending").length;
		const failed = questions.filter((q) => q.delivery === "failed").length;
		const label = `${pending} pending${failed ? ` · ${failed} send failed` : ""}${this.actions.errors().length ? " · history error" : ""}`;
		const children: NativeChild[] = [];
		const cardBody: NativeChild[] = [];
		if (this.#expanded) {
			cardBody.push(
				node(
					"tabs",
					{
						items: [
							{ id: "pending", label: `Pending (${pending})` },
							{ id: "answered", label: `Answered (${answered})` },
						],
						active: this.#tab,
						variant: "underline",
					},
					undefined,
					"inbox-tabs",
				),
			);
			const body: NativeChild[] = [];
			if (this.#retry) {
				body.push(
					questionStatus("Delivery is unconfirmed. Retrying may deliver the answer twice.", "warning"),
					row(
						[
							node("button", { role: "omp.btn", text: "Retry answer", variant: "danger", actions: { click: "confirm" } }),
							node("button", { role: "omp.btn", text: "Keep current state", actions: { click: "keep" } }),
						],
						{ gap: "sm", wrap: true },
					),
				);
			} else {
				const visible = questions.filter((q) =>
					this.#tab === "pending" ? q.status === "pending" : q.status !== "pending",
				);
				body.push(...visible.map((q) => this.#question(q)));
				if (!visible.length)
					body.push(
						text(this.#tab === "pending" ? "No pending questions." : "No answered questions yet.", { tone: "muted" }),
					);
			}
			if (this.#message) body.push(questionStatus(sanitizeText(this.#message), "warning"));
			body.push(...this.actions.errors().map((error) => questionStatus(sanitizeText(error), "error")));
			const scroller = node(
				"col",
				{
					role: "async-ask.body",
					gap: "sm",
					max: { h: `${Math.max(4, Math.floor(this.host.terminal.rows * 0.5))}lines` },
				},
				body,
				"questions",
			);
			cardBody.push({ ...scroller, scroll: { by: "start", n: this.#scrollVersion } });
		}
		children.push(
			questionBlock(context,
				{
					role: "async-ask.panel",
					title: "Questions",
					target: label,
					status: failed || this.actions.errors().length ? "error" : pending ? "pending" : "done",
					collapsed: !this.#expanded,
					preview: { lines: 0 },
				},
				cardBody,
				"panel",
			),
		);
		// The native composer's context gauge sits above its layout box, even while idle.
		children.push(
			node(
				"spacer",
				{ role: "async-ask.clearance", size: "none", min: { h: "1lines" }, shrink: 0 },
				undefined,
				"clearance",
			),
		);
		return (this.#native = row(
			[
				node("spacer", { grow: 1 }),
				col(children, { gap: "sm", role: "async-ask.dock", grow: 100, min: { w: 0 }, max: { w: "92ch" } }),
				node("spacer", { grow: 1 }),
			],
			{ align: "start" },
		));
	}

	render(): readonly string[] {
		if (!this.#expanded && !this.#hadPending) return [];
		return [
			`Questions · ${this.actions.questions().filter((q) => q.status === "pending").length} pending · /questions`,
			"",
		];
	}

	#refresh(): void {
		this.invalidate();
		this.host.requestRender();
	}

	invalidate(): void {
		this.#native = undefined;
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		logger.debug("Async Ask panel disposed");
		this.#unsubscribe();
		this.#releaseKeys();
		for (const form of this.#forms.values()) form.dispose();
		this.#forms.clear();
	}
}
