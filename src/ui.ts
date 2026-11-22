import type { Component, Focusable } from "@oh-my-pi/pi-tui";
import { HtmlFormDialog, type HtmlFormHost } from "@oh-my-pi/pi-tui/html-form/dialog";
import type { HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { col, elapsed, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import { formatAge, sanitizeText } from "@oh-my-pi/pi-utils";
import type { AnswerNote, Question } from "./state";

export interface InboxActions {
	questions(): readonly Question[];
	errors(): readonly string[];
	subscribe(listener: () => void): () => void;
	submit(id: string, data: HtmlFormData, notes: AnswerNote[]): void;
	retry(id: string): void;
	close(): void;
}

function clean(value: string): string {
	return replaceTabs(sanitizeText(value));
}
function status(question: Question): string {
	if (question.status === "withdrawn") return "Withdrawn";
	if (question.status === "pending") return "Pending";
	return question.delivery === "recorded" ? "Answered · recorded" : `Answered · delivery ${question.delivery}`;
}

/** Adapt only public action-button descriptors; keep the SDK's fields, validation and event routing. */
function inboxFormNode(description: NativeNode): NativeNode {
	if (description.k === "button" && description.p?.role === "omp.btn") {
		const cancel = description.p.actions?.click === "cancel" && description.p.text === "Cancel";
		const submit = description.p.actions?.click === "submit";
		return {
			...description,
			p: {
				...description.p,
				role: "async-ask.button",
				variant: submit ? "primary" : "default",
				...(cancel
					? {
							text: "Skip for now",
							icon: "clock",
							title: "Leave pending; keep this draft while the inbox stays open",
						}
					: submit
						? { text: "Send answer", icon: "check", title: "Submit this answer to the agent" }
						: {}),
			},
		};
	}
	return description.c
		? { ...description, c: description.c.map(child => ("k" in child ? inboxFormNode(child) : child)) }
		: description;
}

class InboxForm extends HtmlFormDialog {
	#source: NativeNode | undefined;
	#adapted: NativeNode | undefined;
	override describe(context: DescribeContext): NativeNode {
		const source = super.describe(context);
		if (source !== this.#source) {
			this.#source = source;
			this.#adapted = inboxFormNode(source);
		}
		return this.#adapted!;
	}
}

export class QuestionIndicator implements Component {
	#unsubscribe: () => void;
	#native: NativeNode | undefined;
	constructor(
		readonly actions: InboxActions,
		readonly open: () => void,
		readonly host?: HtmlFormHost,
	) {
		this.#unsubscribe = actions.subscribe(() => {
			this.invalidate();
			host?.requestRender();
		});
	}
	#label(): string {
		const questions = this.actions.questions();
		const pending = questions.filter(question => question.status === "pending").length;
		const uncertain = questions.filter(question => question.delivery === "unconfirmed").length;
		return `Questions · ${pending} pending${uncertain ? ` · ${uncertain} unconfirmed` : ""}${this.actions.errors().length ? " · history error" : ""}`;
	}
	render(width: number): readonly string[] {
		return [truncateToWidth(`${this.#label()} · /questions`, width)];
	}
	describe(): NativeNode {
		return (this.#native ??= node("button", {
			text: this.#label(),
			icon: "inbox",
			variant: "default",
			size: "md",
			title: "Open questions — answer now or leave them for later",
			actions: { click: "open" },
		}));
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "action" && event.act === "open") this.open();
	}
	invalidate(): void {
		this.#native = undefined;
	}
	dispose(): void {
		this.#unsubscribe();
	}
}

/** Owns focus only while opened by the user; agent execution has no dependency on this component. */
export class QuestionInbox implements Component, Focusable {
	// Keep outside omp.overlay.*: its list padding collides with embedded Ask markers.
	readonly nativeOverlay = { role: "async-ask.inbox", head: "Questions", size: "lg" as const };
	#focused = false;
	#selected: string | undefined;
	#expanded: string | undefined;
	#initialized = false;
	#forms = new Map<string, HtmlFormDialog>();
	#skipped = new Set<string>();
	#confirm: "discard" | "retry" | undefined;
	#message = "";
	#native: NativeNode | undefined;
	#unsubscribe: () => void;
	#disposed = false;
	constructor(
		readonly actions: InboxActions,
		readonly host?: HtmlFormHost,
		readonly cwd?: string,
	) {
		this.#unsubscribe = actions.subscribe(() => this.#sync());
		this.#sync();
	}
	get #form(): HtmlFormDialog | undefined {
		return this.#expanded ? this.#forms.get(this.#expanded) : undefined;
	}
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		if (this.#form) this.#form.focused = value && !this.#confirm;
	}
	get debugChildren(): readonly Component[] {
		return this.#form && !this.#confirm ? [this.#form] : [];
	}
	debugState(): Record<string, unknown> {
		return {
			selected: this.#selected,
			expanded: this.#expanded ?? null,
			form: this.#form ? this.#expanded : null,
			skipped: [...this.#skipped],
			confirmation: this.#confirm ?? null,
		};
	}
	#sync(): void {
		if (this.#disposed) return;
		const questions = this.actions.questions();
		let advanceFrom: string | undefined;
		for (const [id, form] of this.#forms) {
			const current = questions.find(question => question.id === id);
			if (current?.status === "pending") continue;
			if (this.#expanded === id) {
				advanceFrom = id;
				this.#message = current?.status === "withdrawn" ? `Withdrawn: ${current.reason}` : "Answer submitted.";
			}
			form.dispose();
			this.#forms.delete(id);
			this.#skipped.delete(id);
		}
		if (!this.#initialized && questions.length) {
			this.#initialized = true;
			this.#expand(
				(
					questions.find(question => question.status === "pending") ??
					questions.find(question => question.delivery === "unconfirmed") ??
					questions[0]
				)?.id,
			);
		} else if (advanceFrom) {
			this.#confirm = undefined;
			this.#expand(this.#nextPending(advanceFrom));
		} else if (this.#expanded && !questions.some(question => question.id === this.#expanded)) {
			this.#expand(undefined);
		}
		if (!questions.some(question => question.id === this.#selected)) this.#selected = questions[0]?.id;
		this.#refresh();
	}
	#nextPending(after: string, includeSkipped = true): string | undefined {
		const questions = this.actions.questions();
		const index = questions.findIndex(question => question.id === after);
		for (let offset = 1; offset <= questions.length; offset++) {
			const question = questions[(index + offset) % questions.length]!;
			if (
				question.id !== after &&
				question.status === "pending" &&
				(includeSkipped || !this.#skipped.has(question.id))
			)
				return question.id;
		}
		return undefined;
	}
	#expand(id: string | undefined): void {
		if (id === this.#expanded) return;
		if (this.#form) {
			this.#form.focused = false;
			this.#skipped.add(this.#expanded!);
		}
		this.#expanded = id;
		if (!id) return;
		this.#selected = id;
		this.#skipped.delete(id);
		const question = this.actions.questions().find(question => question.id === id);
		if (!question || question.status !== "pending" || this.actions.errors().length) return;
		let form = this.#forms.get(id);
		if (!form) {
			form = new InboxForm(parseHtmlForm(question.html), {
				title: clean(question.title),
				tui: this.host,
				cwd: this.cwd,
				acceptImages: false,
				onSubmit: (data, notes) => {
					// Detached forms keep drafts, not permission to submit a stale answer.
					if (this.#disposed || this.#confirm || this.#expanded !== id) return;
					if (this.actions.questions().find(current => current.id === id)?.status !== "pending") return;
					try {
						this.actions.submit(id, data, notes);
					} catch (error) {
						this.#message = String(error);
					}
					this.#sync();
				},
				onCancel: () => {
					if (!this.#disposed && this.#expanded === id && !this.#confirm) this.#skip();
				},
				releaseKeys: () => {
					if (this.#disposed || this.#expanded !== id || this.#confirm) return;
					this.#expand(undefined);
					this.#refresh();
				},
			});
			this.#forms.set(id, form);
		}
		form.focused = this.#focused;
	}
	#skip(): void {
		if (!this.#form || !this.#expanded) return;
		const previous = this.#expanded;
		this.#skipped.add(previous);
		this.#expand(this.#nextPending(previous, false));
		this.#refresh();
	}
	#close(): void {
		if ([...this.#forms.values()].some(form => form.givenAnswers())) {
			this.#confirm = "discard";
			if (this.#form) this.#form.focused = false;
			this.#refresh();
		} else this.actions.close();
	}
	#acceptConfirmation(): void {
		if (this.#confirm === "discard") {
			this.actions.close();
			return;
		}
		if (this.#confirm === "retry" && this.#expanded) {
			this.#confirm = undefined;
			try {
				this.actions.retry(this.#expanded);
			} catch (error) {
				this.#message = String(error);
			}
		}
		this.#sync();
	}
	#cancelConfirmation(): void {
		this.#confirm = undefined;
		if (this.#form) this.#form.focused = this.#focused;
		this.#refresh();
	}
	#retry(): void {
		if (this.actions.questions().some(q => q.id === this.#expanded && q.delivery === "unconfirmed"))
			this.#confirm = "retry";
	}
	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#confirm) {
			if (matchesKey(data, "enter")) this.#acceptConfirmation();
			else if (matchesKey(data, "escape")) this.#cancelConfirmation();
		} else if (matchesKey(data, "ctrl+down") || matchesKey(data, "ctrl+up")) {
			const questions = this.actions.questions();
			const index = questions.findIndex(question => question.id === this.#selected);
			const next = index + (matchesKey(data, "ctrl+up") ? -1 : 1);
			this.#expand(questions[Math.max(0, Math.min(questions.length - 1, next))]?.id);
		} else if (this.#form) this.#form.handleInput(data);
		else if (matchesKey(data, "escape")) this.#close();
		else if (data === "r") this.#retry();
		else if (matchesKey(data, "enter")) this.#expand(this.#expanded === this.#selected ? undefined : this.#selected);
		else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const questions = this.actions.questions();
			const index = questions.findIndex(question => question.id === this.#selected);
			this.#selected =
				questions[Math.max(0, Math.min(questions.length - 1, index + (matchesKey(data, "up") ? -1 : 1)))]?.id;
		}
		this.#refresh();
	}
	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (this.#confirm) {
			if (event.type === "action" && event.act === "confirm") this.#acceptConfirmation();
			else if (event.type === "action" && event.act === "keep") this.#cancelConfirmation();
		} else if (event.type === "toggle") {
			const question = this.actions
				.questions()
				.find(candidate => event.key === candidate.id || event.key.endsWith(`/${candidate.id}`));
			if (question) {
				if (!event.collapsed) this.#expand(question.id);
				else if (this.#expanded === question.id) this.#expand(undefined);
			}
		} else if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "retry") this.#retry();
		}
		this.#refresh();
	}
	#confirmationText(): string {
		return this.#confirm === "discard"
			? "Close and discard unsent drafts? Your questions will remain pending."
			: "Delivery is unconfirmed. Retrying may deliver the answer twice.";
	}
	render(width: number): readonly string[] {
		const lines = ["Questions · agent work continues", ""];
		if (this.#confirm) {
			lines.push(this.#confirmationText(), "Enter confirms · Esc keeps the current state");
		} else {
			const questions = this.actions.questions();
			if (!questions.length) lines.push("All clear. New questions will appear here.");
			const count = Math.max(3, (this.host?.terminal.rows ?? 30) - 12);
			const index = questions.findIndex(question => question.id === this.#selected);
			const start = Math.max(0, index - count + 1);
			for (const question of questions.slice(start, start + count)) {
				const expanded = question.id === this.#expanded;
				const state = this.#skipped.has(question.id) ? "Skipped · still pending" : status(question);
				lines.push(
					`${question.id === this.#selected ? ">" : " "} ${expanded ? "▾" : "▸"} ${question.title} · ${state} · ${formatAge((Date.now() - question.createdAt) / 1000)}`,
				);
				if (!expanded) continue;
				lines.push(`  Depends on this: ${question.blockedWork}`);
				if (this.#form) lines.push(...this.#form.render(width));
				if (question.reason) lines.push(`  Withdrawn: ${question.reason}`);
				if (question.answer)
					lines.push(JSON.stringify(question.answer.data), ...question.answer.notes.map(note => note.text));
			}
			lines.push("", "Ctrl+↑/↓ question · Esc folds, then closes · Enter expands · r retries unconfirmed");
		}
		if (this.#message) lines.push("", this.#message);
		lines.push(...this.actions.errors());
		return lines.map(line => truncateToWidth(clean(line), width));
	}
	#card(question: Question): NativeNode {
		const expanded = question.id === this.#expanded;
		const skipped = this.#skipped.has(question.id);
		const answered = question.status === "answered";
		const tone = answered ? "success" : skipped ? "warning" : expanded ? "accent" : "muted";
		const body: NativeChild[] = [];
		if (expanded) {
			body.push(
				text([span("Depends on this: ", "muted"), span(clean(question.blockedWork))], { wrap: "word" }),
				row([text("Asked", { tone: "muted" }), elapsed(Date.now() - question.createdAt)], { gap: "sm" }),
			);
			if (this.#form) body.push(this.#form);
			if (question.reason) body.push(text(clean(question.reason), { tone: "muted", wrap: "word" }));
			if (question.answer) {
				body.push(
					node("kv", {
						items: Object.entries(question.answer.data).map(([k, v]) => ({
							k: clean(k),
							v: clean(Array.isArray(v) ? v.join(", ") : String(v)),
						})),
					}),
					...question.answer.notes.map(note =>
						text(clean(`${note.question} — ${note.option}: ${note.text}`), { wrap: "word" }),
					),
				);
			}
			if (question.delivery === "unconfirmed") {
				body.push(
					text("Your answer is saved, but delivery to the agent is unconfirmed.", {
						tone: "warning",
						wrap: "word",
					}),
					node("button", { text: "Review retry…", icon: "repeat", actions: { click: "retry" } }),
				);
			}
		}
		return node(
			"card",
			{
				head: [
					span(clean(question.title), `strong ${answered ? "success" : skipped ? "warning" : ""}`),
					span(
						`  ·  ${skipped ? "Skipped · still pending" : status(question)}`,
						answered ? "success" : skipped ? "warning" : "muted",
					),
				],
				role: answered ? "async-ask.check" : skipped ? "async-ask.clock" : "async-ask.help",
				tone,
				status: answered ? "done" : skipped ? "pending" : undefined,
				collapsible: true,
				collapsed: !expanded,
			},
			body,
			question.id,
		);
	}
	describe(_context: DescribeContext): NativeNode {
		if (this.#native) return this.#native;
		const questions = this.actions.questions();
		const pending = questions.filter(question => question.status === "pending").length;
		const answered = questions.filter(question => question.status === "answered").length;
		const body: NativeChild[] = [
			row(
				[
					row(
						[
							node("badge", { text: `${pending} pending`, tone: pending ? "pending" : "muted" }),
							node("badge", { text: `${answered} answered`, tone: answered ? "success" : "muted" }),
						],
						{ gap: "sm", wrap: true },
					),
					node("button", { text: "Close", icon: "x", actions: { click: "close" } }),
				],
				{ justify: "between", gap: "md", wrap: true },
			),
			text("Agent work continues. Skipping never submits an answer.", { tone: "muted", wrap: "word" }),
		];
		if (this.#confirm) {
			body.push(
				node("card", { head: this.#confirmationText(), role: "async-ask.warn", tone: "warning" }, [
					row(
						[
							node("button", {
								text: this.#confirm === "discard" ? "Discard drafts and close" : "Retry answer",
								variant: "danger",
								actions: { click: "confirm" },
							}),
							node("button", { text: "Keep current state", actions: { click: "keep" } }),
						],
						{ gap: "sm", wrap: true },
					),
				]),
			);
		} else if (questions.length) {
			body.push(
				col(
					questions.map(q => this.#card(q)),
					{ gap: "sm" },
				),
			);
		} else {
			body.push(
				row(
					[
						node("icon", { name: "inbox", tone: "muted" }),
						col(
							[text([span("All clear", "strong")]), text("New questions will appear here.", { tone: "muted" })],
							{ gap: "sm" },
						),
					],
					{ gap: "md" },
				),
			);
		}
		if (this.#message) body.push(text(clean(this.#message), { tone: "muted", wrap: "word" }));
		body.push(...this.actions.errors().map(error => text(clean(error), { tone: "error", wrap: "word" })));
		return (this.#native = col(body, { gap: "md" }));
	}
	#refresh(): void {
		this.invalidate();
		this.host?.requestRender();
	}
	invalidate(): void {
		this.#native = undefined;
	}
	dispose(): void {
		this.#disposed = true;
		this.#unsubscribe();
		for (const form of this.#forms.values()) form.dispose();
		this.#forms.clear();
	}
}
