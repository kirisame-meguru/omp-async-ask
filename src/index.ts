import type { ExtensionAPI, ExtensionContext, ExtensionUiHost } from "@oh-my-pi/pi-coding-agent";
import { nativeRendering, onCleanup, UiNode } from "@oh-my-pi/pi-tui";
import { isRecord, logger, prompt, truncate } from "@oh-my-pi/pi-utils";
import { QuestionAttention } from "./attention";
import { AVAILABLE, createQuestionSource, serveQuestionSources, type OwnedQuestionSource } from "./bridge";
import { AnswerDelivery } from "./delivery";
import { AnswerCard, questionRenderers, savedAnswerPresentation, summarizeAnswer } from "./presentation";
import { QuestionPanel } from "./panel";
import contextTemplate from "./prompts/context.md" with { type: "text" };
import goalPolicy from "./prompts/goal-policy.md" with { type: "text" };
import receiptTemplate from "./prompts/receipt.md" with { type: "text" };
import toolDescription from "./prompts/tool.md" with { type: "text" };
import { ANSWER_TYPE, EVENT_TYPE, QuestionStore } from "./state";
import { type InboxActions, QuestionInbox, QuestionIndicator } from "./ui";

const CONTEXT_TYPE = "omp-async-ask:context";
const WIDGET = "omp-async-ask";
const CONTEXT_LIMIT = 8;
const CONTEXT_TEXT_LIMIT = 240;

interface Connection {
	ctx: ExtensionContext;
	store: QuestionStore;
	delivery: AnswerDelivery;
	attention: QuestionAttention;
	unsubscribeWidget?: () => void;
	source?: OwnedQuestionSource;
	overlay?: AbortController;
	panel?: QuestionPanel;
	panelRequested?: boolean;
}
function supported(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && ctx.hasUI && ctx.agent.kind === "main";
}

export default function asyncAsk(pi: ExtensionAPI): void {
	let connection: Connection | undefined;
	let stopServing: (() => void) | undefined;
	function serve() {
		stopServing ??= serveQuestionSources(pi.events, () => connection?.source);
	}
	serve();
	function invalidate(): void {
		const previous = connection;
		connection = undefined;
		if (!previous) return;
		logger.debug("Async Ask owner invalidated", {
			sessionId: previous.store.sessionId,
			currentSessionId: previous.ctx.sessionManager.getSessionId(),
			hasPanel: Boolean(previous.panel),
		});
		previous.unsubscribeWidget?.();
		previous.source?.close();
		previous.delivery.dispose();
		previous.attention.dispose();
		previous.overlay?.abort();
		previous.panel?.dispose();
		previous.ctx.ui.setWidget(WIDGET, undefined);
	}
	function actions(owner: Connection, close: () => void): InboxActions {
		return {
			questions: () => owner.store.list(),
			errors: () => owner.store.errors,
			subscribe: listener => owner.store.subscribe(listener),
			submit: (id, data, notes) => owner.delivery.submit(id, data, notes),
			retry: id => owner.delivery.retry(id),
			close,
		};
	}
	function mountPanel(owner: Connection, ui: ExtensionUiHost): UiNode {
		if (connection !== owner) return new UiNode("col", {});
		owner.panel?.dispose();
		const panel = new QuestionPanel(actions(owner, () => {}), ui, owner.ctx.cwd,
			owner.ctx.ui.composer ? handler => owner.ctx.ui.composer!.addKeyHandler(handler) : undefined);
		owner.panel = panel;
		onCleanup(() => {
			panel.dispose();
			if (owner.panel === panel) owner.panel = undefined;
		});
		if (owner.panelRequested) {
			owner.panelRequested = false;
			panel.open();
		}
		return panel.view();
	}
	function ensure(ctx: ExtensionContext): Connection {
		if (!supported(ctx))
			throw new Error(
				"ask_async requires a top-level interactive OMP session. Report the question to the parent or use an available user-input channel.",
			);
		if (connection?.store.sessionId === ctx.sessionManager.getSessionId()) return connection;
		invalidate();
		serve();
		const sessionId = ctx.sessionManager.getSessionId();
		const store = new QuestionStore(sessionId, event => {
			if (connection?.store !== store || ctx.sessionManager.getSessionId() !== sessionId) {
				throw new Error("The originating session changed; reopen /questions.");
			}
			pi.appendEntry(EVENT_TYPE, event);
		});
		store.restore(ctx.sessionManager.getBranch());
		logger.debug("Async Ask owner restored", {
			sessionId, pending: store.list().filter(question => question.status === "pending").length,
		});
		const delivery = new AnswerDelivery(store, {
			sessionId: () => ctx.sessionManager.getSessionId(),
			isIdle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
			entries: () => ctx.sessionManager.getBranch(),
			send: (message, options) => pi.sendMessage(message, options),
		});
		const owner: Connection = { ctx, store, delivery, attention: new QuestionAttention(store) };
		connection = owner;
		owner.source = createQuestionSource(store, delivery, () => connection === owner && ctx.sessionManager.getSessionId() === sessionId, (question, reason) => {
			if (connection !== owner || ctx.sessionManager.getSessionId() !== sessionId) return;
			pi.sendMessage({
				customType: "omp-away:call-result", display: true, attribution: "agent",
				content: JSON.stringify({ question: question.id, title: question.title, voiceDiscussion: reason }),
			}, { deliverAs: "aside" });
		});
		pi.events.emit(AVAILABLE, { version: 1, sessionId });
		let widgetVisible = false;
		const syncWidget = () => {
			// Native history and drafts live with the session, not the pending count.
			if (owner.panel || owner.panelRequested) return;
			const pending = store.list().some(question => question.status === "pending");
			if (pending === widgetVisible) return;
			widgetVisible = pending;
			ctx.ui.setWidget(
				WIDGET,
				pending
					? ui => {
							if (nativeRendering()) return mountPanel(owner, ui);
							return QuestionIndicator(actions(owner, () => {}), () => {
								if (connection !== owner) return;
								void open(ctx).catch(error => ctx.ui.notify(String(error), "error"));
							});
						}
					: undefined,
			);
		};
		owner.unsubscribeWidget = store.subscribe(syncWidget);
		syncWidget();
		return owner;
	}
	async function open(ctx: ExtensionContext): Promise<void> {
		const owner = ensure(ctx);
		if (owner.overlay) return;
		owner.delivery.settle();
		if (nativeRendering()) {
			if (owner.panel) owner.panel.open();
			else {
				owner.panelRequested = true;
				ctx.ui.setWidget(WIDGET, ui => mountPanel(owner, ui));
			}
			return;
		}
		const abort = new AbortController();
		owner.overlay = abort;
		let inbox: QuestionInbox | undefined;
		try {
			await ctx.ui.custom<void>(
				(tui, _theme, _keys, done) => {
					inbox = new QuestionInbox(
						actions(owner, () => done()),
						tui,
						ctx.cwd,
					);
					return inbox.view();
				},
				{ overlay: true, signal: abort.signal },
			);
		} catch (error) {
			if (!abort.signal.aborted) throw error;
		} finally {
			inbox?.dispose();
			if (owner.overlay === abort) owner.overlay = undefined;
		}
	}
	const parameters = pi.arktype({
		op: "'create' | 'list' | 'withdraw'",
		"title?": "string",
		"html?": "string",
		"blockedWork?": "string",
		"continueWith?": "string[]",
		"key?": "string",
		"id?": "string",
		"reason?": "string",
	});
	pi.registerMessageRenderer(ANSWER_TYPE, (message, options) => {
		const details = isRecord(message.details) ? message.details : {};
		const question = details.sessionId === connection?.store.sessionId && typeof details.requestId === "string"
			? connection?.store.get(details.requestId) : undefined;
		const summary = savedAnswerPresentation(details)
			?? (question?.answer?.id === details.answerId && question?.answer ? summarizeAnswer(question) : undefined);
		if (!summary) return undefined;
		const raw = typeof message.content === "string"
			? message.content : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
		return AnswerCard(summary, options.expanded, raw);
	});
	pi.registerTool<typeof parameters>({
		name: "ask_async",
		label: "Ask asynchronously",
		description: toolDescription,
		approval: "read",
		defaultInactive: true,
		parameters,
		...questionRenderers(id => {
			const owner = connection;
			if (owner && (!id || owner.store.get(id))) void open(owner.ctx);
		}, id => connection?.store.get(id), listener => connection?.store.subscribe(listener)),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			try {
				signal?.throwIfAborted();
				const owner = ensure(ctx);
				if (params.op === "list") {
					const questions = owner.store.list().map(({ id, title, status, delivery, blockedWork }) => ({
						id,
						title,
						status,
						delivery,
						blockedWork,
					}));
					const details = { questions, errors: owner.store.errors };
					return {
						content: [
							{ type: "text", text: prompt.render(receiptTemplate, { json: JSON.stringify(details, null, 2) }) },
						],
						details,
					};
				}
				const question =
					params.op === "withdraw"
						? owner.store.withdraw(params.id ?? "", params.reason ?? "")
						: owner.store.create(
								{
									title: params.title ?? "",
									html: params.html ?? "",
									blockedWork: params.blockedWork ?? "",
									continueWith: params.continueWith,
									key: params.key,
								},
								toolCallId,
							);
				const details = {
					id: question.id, status: question.status, delivery: question.delivery,
					title: question.title, blockedWork: question.blockedWork, reason: question.reason,
				};
				return {
					content: [
						{
							type: "text",
							text: prompt.render(receiptTemplate, {
								pending: question.status === "pending",
								withdrawn: question.status === "withdrawn",
								json: JSON.stringify(details),
							}),
						},
					],
					details,
				};
			} catch (error) {
				return { content: [{ type: "text", text: String(error) }], details: {}, isError: true };
			}
		},
	});
	pi.registerCommand("questions", {
		description: "Answer non-blocking questions without stopping agent work",
		handler: (_args, ctx) => open(ctx),
	});

	async function restore(_event: unknown, ctx: ExtensionContext): Promise<void> {
		invalidate();
		if (!supported(ctx)) return;
		ensure(ctx);
		const active = pi.getActiveTools();
		if (!active.includes("ask_async")) await pi.setActiveTools([...active, "ask_async"]);
	}
	pi.on("session_start", restore);
	pi.on("session_switch", restore);
	pi.on("session_branch", restore);
	pi.on("session_tree", restore);
	pi.on("session_clear", restore);
	pi.on("session_before_switch", invalidate);
	pi.on("session_before_branch", invalidate);
	pi.on("session_before_tree", invalidate);
	pi.on("session_shutdown", () => {
		invalidate();
		stopServing?.();
		stopServing = undefined;
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!supported(ctx)) return;
		return { systemPrompt: [...event.systemPrompt, goalPolicy] };
	});
	pi.on("message_end", (event, ctx) => {
		if (supported(ctx)) connection?.delivery.observe(event.message);
	});
	pi.on("session_compact", () => connection?.delivery.settle());
	pi.on("agent_end", (event, ctx) => {
		if (!supported(ctx) || event.willContinue) return;
		const owner = connection;
		// One observation after the event unwinds, never a continuation or polling timer.
		ctx.setTimeout(() => {
			if (connection === owner) owner?.delivery.settle();
		}, 0);
	});
	pi.on("context", (event, ctx) => {
		if (!supported(ctx)) return;
		const owner = ensure(ctx);
		const pending = owner.store.list().filter(question => question.status === "pending");
		if (!pending.length) return;
		const snapshot = pending.slice(0, CONTEXT_LIMIT).map(question => ({
			id: question.id,
			title: truncate(question.title, CONTEXT_TEXT_LIMIT),
			blockedWork: truncate(question.blockedWork, CONTEXT_TEXT_LIMIT),
		}));
		return {
			messages: [
				...event.messages.filter(message => message.role !== "custom" || message.customType !== CONTEXT_TYPE),
				{
					role: "custom",
					customType: CONTEXT_TYPE,
					display: false,
					timestamp: Date.now(),
					attribution: "agent",
					content: prompt.render(contextTemplate, {
						count: pending.length,
						json: JSON.stringify(snapshot, null, 2),
					}),
				},
			],
		};
	});
}
