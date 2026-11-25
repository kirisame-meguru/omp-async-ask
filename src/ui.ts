import type { Component, Focusable } from "@oh-my-pi/pi-tui";
import { writeTerminalSequence } from "@oh-my-pi/pi-tui";
import { HtmlFormDialog, type HtmlFormHost } from "@oh-my-pi/pi-tui/html-form/dialog";
import type { HtmlFormData } from "@oh-my-pi/pi-tui/html-form/data";
import { parseHtmlForm } from "@oh-my-pi/pi-tui/html-form/parse";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { col, elapsed, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { segmentedTabs } from "@oh-my-pi/pi-tui/native/overlay";
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
	return question.delivery === "failed" ? "Answered · send failed"
		: question.delivery === "unconfirmed" ? "Answered · delivery unconfirmed" : "Answered";
}

/** Adapt native chrome only; retain the SDK's fields, validation and event ownership. */
function inboxFormNode(description: NativeNode): NativeNode {
	if (description.k === "button" && description.p?.role === "omp.btn") {
		const cancel = description.p.actions?.click === "cancel" && description.p.text === "Cancel";
		const submit = description.p.actions?.click === "submit";
		return {
			...description,
			p: {
				...description.p,
				...(cancel
					? {
							text: "Skip for now",
							title: "Leave pending; keep this draft while the inbox stays open",
						}
					: submit
						? { text: "Send answer", title: "Submit this answer to the agent" }
						: {}),
			},
		};
	}
	const children = description.c
		?.filter(child => !("k" in child) || child.p?.role !== "omp.ask.card.head")
		.map(child => ("k" in child ? inboxFormNode(child) : child));
	const role = description.p?.role;
	if (description.k === "col" && (role === "omp.ask.card" || role === "omp.ask.card.body" || role === "omp.ask.open")) {
		return {
			...description,
			c: children,
			reveal: undefined,
		};
	}
	if (description.k === "row" && role === "omp.ask.pills") {
		return { ...description, k: "col", p: { role: "async-ask.options", gap: "xs" }, c: children };
	}
	return children ? { ...description, c: children } : description;
}

// Use OMP's native heads and the same theme tokens as its output wells.
// Text-only tools need a body well too; Tern otherwise frames only code/ANSI children.
const FORM_STYLES = "\x1b_tsp;s;" + JSON.stringify({
	name: "async-ask-fields",
	css: `
[data-role^='async-ask.'],
[data-role^='async-ask.'] .sf-text,
[data-role^='async-ask.'] .sf-card-head,
[data-role^='async-ask.'] .sf-tool-target.text,
[data-role^='async-ask.'] .sf-elapsed {
	font-family: var(--sans);
}
.sf-tool[data-role='omp.tool.ask_async'] > .sf-tool-body,
.sf-tool[data-role^='async-ask.'] > .sf-tool-body {
	border: 1px solid var(--l2);
	border-radius: var(--r-card);
	background: var(--code-bg);
	padding: 12px 14px;
	margin-top: 8px;
}
[data-role='async-ask.receipt'] > .sf-section + [data-role='async-ask.receipt.footer'] {
	border-top: 1px solid var(--l2);
	padding-top: 8px;
}
[data-role='async-ask.body'] {
	overflow-y: auto;
	min-height: 0;
	overscroll-behavior-y: contain;
}
[data-role='async-ask.body'] > * {
	flex-shrink: 0;
}
[data-role='async-ask.body'] > [data-role='async-ask.question'] + [data-role='async-ask.question'] {
	border-top: 1px solid var(--l2);
	padding-top: 12px;
}
[data-role='async-ask.form'] [data-role='omp.ask.card'],
[data-role='async-ask.form'] [data-role='omp.ask.card.body'],
[data-role='async-ask.form'] [data-role='omp.ask.open'] {
	border: none;
	background: none;
	box-shadow: none;
	padding: 0;
	margin: 0;
}
`,
}) + "\x1b\\";

export function applyQuestionStyles(context: DescribeContext): boolean {
	if (!context.feature("styles")) return false;
	writeTerminalSequence(FORM_STYLES);
	return true;
}

/** Let Tern draw the same data head and body frame it uses for OMP tools. */
export function questionBlock(
	context: DescribeContext,
	props: {
		role: string;
		title: string;
		target?: string;
		note?: string;
		status: "pending" | "done" | "error" | "cancelled";
		collapsed?: boolean;
		preview?: { lines: number } | "children";
	},
	body: readonly NativeChild[],
	key?: string,
): NativeNode {
	const collapsible = props.collapsed !== undefined;
	if (context.supports("tool")) {
		return node("tool", {
			...props,
			name: "ask",
			targetKind: "text",
			frame: "card",
			collapsible,
		}, body, key);
	}
	return node("card", {
		role: props.role,
		head: [
			span(props.title, "strong"),
			...(props.target ? [span(` · ${props.target}`)] : []),
			...(props.note ? [span(` · ${props.note}`, "muted")] : []),
		],
		status: props.status,
		collapsible,
		collapsed: props.collapsed,
		preview: props.preview === "children" ? { lines: 8 } : props.preview,
	}, body, key);
}

export function questionStatus(label: string, tone: "muted" | "success" | "warning" | "error", icon?: string): NativeNode {
	return row([
		node("icon", { name: icon ?? (tone === "success" ? "check" : tone === "error" ? "x" : tone === "warning" ? "warn" : "clock"), tone }),
		text([span(label, tone)], { wrap: "word" }),
	], { gap: "sm", align: "baseline", role: "async-ask.status" });
}

export class InboxForm extends HtmlFormDialog {
	#source: NativeNode | undefined;
	#adapted: NativeNode | undefined;
	#styled = false;
	override describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		const source = super.describe(context);
		if (source !== this.#source) {
			this.#source = source;
			this.#adapted = col([inboxFormNode(source)], { role: "async-ask.form" });
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
		const failed = questions.filter(question => question.delivery === "failed").length;
		return `Questions · ${pending} pending${failed ? ` · ${failed} send failed` : ""}${this.actions.errors().length ? " · history error" : ""}`;
	}
	render(width: number): readonly string[] {
		return [truncateToWidth(`${this.#label()} · /questions`, width)];
	}
	describe(): NativeNode {
		if (this.#native) return this.#native;
		const questions = this.actions.questions();
		const pending = questions.some(question => question.status === "pending");
		const failed = questions.some(question => question.delivery === "failed");
		const errors = this.actions.errors().length > 0;
		return (this.#native = node("button", {
			role: "omp.btn",
			text: this.#label(),
			icon: errors || failed ? "warn" : "inbox",
			variant: pending ? "primary" : "default",
			tone: pending ? "accent" : "neutral",
			size: "md",
			title: errors
				? "Inbox history needs attention"
				: pending
					? "Questions are waiting for your answer"
					: failed
						? "An answer could not be sent — open the inbox to review"
						: "Open answered questions",
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

type InboxTab = "pending" | "answered";

/** Owns focus only while opened by the user; agent execution has no dependency on this component. */
export class QuestionInbox implements Component, Focusable {
	// Keep outside omp.overlay.*: its list padding collides with embedded Ask markers.
	readonly nativeOverlay = { role: "async-ask.inbox", head: "Questions", size: "lg" as const };
	#focused = false;
	#selected: string | undefined;
	#expanded: string | undefined;
	#initialized = false;
	#tab: InboxTab = "pending";
	#remembered: Partial<Record<InboxTab, string>> = {};
	#hadPending = false;
	#submitting = false;
	#forms = new Map<string, HtmlFormDialog>();
	#skipped = new Set<string>();
	#confirm: "discard" | "retry" | undefined;
	#message = "";
	#native: NativeNode | undefined;
	#styled = false;
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
			tab: this.#tab,
			selected: this.#selected,
			expanded: this.#expanded ?? null,
			form: this.#form ? this.#expanded : null,
			skipped: [...this.#skipped],
			confirmation: this.#confirm ?? null,
		};
	}
	#visibleQuestions(): readonly Question[] {
		return this.actions
			.questions()
			.filter(question => (this.#tab === "pending" ? question.status === "pending" : question.status !== "pending"));
	}
	#first(questions: readonly Question[]): string | undefined {
		return (
			questions.find(question => question.delivery === "failed") ??
			questions.find(question => question.delivery === "unconfirmed") ??
			questions[0]
		)?.id;
	}
	#switchTab(tab: InboxTab): void {
		if (this.#tab === tab) return;
		this.#remembered[this.#tab] = this.#expanded ?? this.#selected;
		this.#expand(undefined);
		this.#tab = tab;
		this.#message = "";
		const questions = this.#visibleQuestions();
		const remembered = this.#remembered[tab];
		this.#selected = questions.some(question => question.id === remembered) ? remembered : this.#first(questions);
		this.#expand(this.#selected);
		this.#refresh();
	}
	#sync(autoClose = true): void {
		if (this.#disposed || this.#submitting) return;
		const questions = this.actions.questions();
		const pending = questions.some(question => question.status === "pending");
		const finished = this.#hadPending && !pending;
		this.#hadPending = pending;
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
		if (finished && autoClose) {
			this.#finishClose();
			return;
		}
		if (!this.#initialized && questions.length) {
			this.#initialized = true;
			this.#tab = pending ? "pending" : "answered";
			this.#expand(this.#first(this.#visibleQuestions()));
		} else if (advanceFrom) {
			this.#confirm = undefined;
			this.#expand(this.#tab === "pending" ? this.#nextPending(advanceFrom) : this.#first(this.#visibleQuestions()));
		} else if (this.#expanded && !this.#visibleQuestions().some(question => question.id === this.#expanded)) {
			this.#expand(undefined);
		}
		const visible = this.#visibleQuestions();
		if (!visible.some(question => question.id === this.#selected)) this.#selected = visible[0]?.id;
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
					this.#submitting = true;
					let failure: string | undefined;
					try {
						this.actions.submit(id, data, notes);
					} catch (error) {
						failure = String(error);
					} finally {
						this.#submitting = false;
					}
					this.#sync(failure === undefined);
					if (failure !== undefined) {
						if (this.actions.questions().find(question => question.id === id)?.status === "answered")
							this.#switchTab("answered");
						this.#message = failure;
						this.#refresh();
					}
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
	#finishClose(): void {
		if (this.#disposed) return;
		this.dispose();
		this.actions.close();
	}
	#close(): void {
		if ([...this.#forms.values()].some(form => form.givenAnswers())) {
			this.#confirm = "discard";
			if (this.#form) this.#form.focused = false;
			this.#refresh();
		} else this.#finishClose();
	}
	#acceptConfirmation(): void {
		if (this.#confirm === "discard") {
			this.#finishClose();
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
		if (
			this.actions
				.questions()
				.some(q => q.id === this.#expanded && (q.delivery === "unconfirmed" || q.delivery === "failed"))
		)
			this.#confirm = "retry";
	}
	handleInput(data: string): void {
		if (this.#disposed) return;
		if (this.#confirm) {
			if (matchesKey(data, "enter")) this.#acceptConfirmation();
			else if (matchesKey(data, "escape")) this.#cancelConfirmation();
		} else if (matchesKey(data, "ctrl+left") || matchesKey(data, "ctrl+right")) {
			this.#switchTab(this.#tab === "pending" ? "answered" : "pending");
		} else if (matchesKey(data, "ctrl+down") || matchesKey(data, "ctrl+up")) {
			const questions = this.#visibleQuestions();
			const index = questions.findIndex(question => question.id === this.#selected);
			const next = index + (matchesKey(data, "ctrl+up") ? -1 : 1);
			this.#expand(questions[Math.max(0, Math.min(questions.length - 1, next))]?.id);
		} else if (this.#form) this.#form.handleInput(data);
		else if (matchesKey(data, "escape")) this.#close();
		else if (data === "r") this.#retry();
		else if (matchesKey(data, "enter")) this.#expand(this.#expanded === this.#selected ? undefined : this.#selected);
		else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			const questions = this.#visibleQuestions();
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
		} else if (
			(event.type === "select" || event.type === "activate") &&
			(event.key === "inbox-tabs" || event.key.endsWith("/inbox-tabs"))
		) {
			if (event.item === "pending" || event.item === "answered") this.#switchTab(event.item);
		} else if (event.type === "toggle") {
			const question = this.#visibleQuestions().find(
				candidate => event.key === candidate.id || event.key.endsWith(`/${candidate.id}`),
			);
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
		const all = this.actions.questions();
		const pending = all.filter(question => question.status === "pending").length;
		const answered = all.filter(question => question.status === "answered").length;
		const lines = [
			"Questions · agent work continues",
			`${this.#tab === "pending" ? ">" : " "} Pending (${pending})  |  ${this.#tab === "answered" ? ">" : " "} Answered (${answered})`,
			"",
		];
		if (this.#confirm) {
			lines.push(this.#confirmationText(), "Enter confirms · Esc keeps the current state");
		} else {
			const questions = this.#visibleQuestions();
			if (!questions.length)
				lines.push(this.#tab === "pending" ? "No pending questions." : "No answered questions yet.");
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
			lines.push(
				"",
				"Ctrl+←/→ tab · Ctrl+↑/↓ question · Esc folds, then closes · Enter expands · r retries unconfirmed",
			);
		}
		if (this.#message) lines.push("", this.#message);
		lines.push(...this.actions.errors());
		return lines.map(line => truncateToWidth(clean(line), width));
	}
	#card(question: Question, context: DescribeContext): NativeNode {
		const expanded = question.id === this.#expanded;
		const skipped = this.#skipped.has(question.id);
		const answered = question.status === "answered";
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
			if (question.delivery === "unconfirmed" || question.delivery === "failed") {
				const failed = question.delivery === "failed";
				body.push(
					text(
						failed
							? "Your answer is saved, but sending failed."
							: "Answer saved. No delivery receipt is available.",
						{ tone: failed ? "warning" : "muted", wrap: "word" },
					),
					node("button", { text: "Review resend…", icon: "repeat", actions: { click: "retry" } }),
				);
			}
		}
		return questionBlock(context, {
			role: "async-ask.question",
			title: "Question",
			target: clean(question.title),
			note: skipped ? "Skipped · still pending" : status(question),
			status: question.delivery === "failed" ? "error" : answered ? "done" : question.status === "withdrawn" ? "cancelled" : "pending",
			collapsed: !expanded,
		}, body, question.id);
	}
	describe(context: DescribeContext): NativeNode {
		if (!this.#styled) this.#styled = applyQuestionStyles(context);
		if (this.#native) return this.#native;
		const questions = this.actions.questions();
		const pending = questions.filter(question => question.status === "pending").length;
		const answered = questions.filter(question => question.status === "answered").length;
		const visible = this.#visibleQuestions();
		const body: NativeChild[] = [
			row(
				[
					segmentedTabs(
						{
							items: [
								{ id: "pending", label: `Pending (${pending})` },
								{ id: "answered", label: `Answered (${answered})` },
							],
							active: this.#tab,
						},
						"inbox-tabs",
					),
					node("button", { role: "omp.btn", text: "Close", icon: "x", variant: "quiet", actions: { click: "close" } }),
				],
				{ justify: "between", gap: "md", wrap: true },
			),
			text("Agent work continues. Skipping never submits an answer.", { tone: "muted", wrap: "word" }),
		];
		if (this.#confirm) {
			body.push(
				questionBlock(context, { title: this.#confirm === "discard" ? "Discard drafts?" : "Review answer delivery", role: "async-ask.warn", status: "pending" }, [
					questionStatus(this.#confirmationText(), "warning"),
					row(
						[
							node("button", {
								role: "omp.btn",
								text: this.#confirm === "discard" ? "Discard drafts and close" : "Retry answer",
								variant: "danger",
								actions: { click: "confirm" },
							}),
							node("button", { role: "omp.btn", text: "Keep current state", actions: { click: "keep" } }),
						],
						{ gap: "sm", wrap: true },
					),
				]),
			);
		} else if (visible.length) {
			body.push(
				col(
					visible.map(q => this.#card(q, context)),
					{ gap: "sm" },
				),
			);
		} else {
			body.push(
				row(
					[
						node("icon", { name: "inbox", tone: "muted" }),
						col(
							[
								text(this.#tab === "pending" ? "No pending questions." : "No answered questions yet.", {
									tone: "muted",
								}),
							],
							{ gap: "sm" },
						),
					],
					{ gap: "md" },
				),
			);
		}
		if (this.#message) body.push(questionStatus(clean(this.#message), "muted"));
		body.push(...this.actions.errors().map(error => questionStatus(clean(error), "error")));
		return (this.#native = col(body, { gap: "md", role: "async-ask.inbox.body" }));
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
