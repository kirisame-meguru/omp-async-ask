# Non-blocking Ask: standalone OMP plugin

Date: 2026-11-22
Status: Design specification for user review; implementation not authorized.

## Objective

Let an OMP agent request user input without suspending its tool execution while the user is unavailable. The user answers through a session-local inbox when convenient. Answers enter the originating conversation without interrupting an executing tool batch.

The motivating failure is a long-running goal stopping on questions while independent implementation and verification remain possible. The plugin removes the blocking interaction; it does not independently decide whether the goal has useful work left.

## Approved constraints

- Standalone installable OMP extension package; no OMP core patches, monkey-patches, private API access, or direct transcript-file mutations.
- One OMP plugin provides both native Tern UI and an ordinary-terminal fallback. No separate Tern plugin, browser server, external messaging service, or daemon.
- Session-local inbox, opened explicitly by the user. New questions never open dialogs or steal focus.
- Use existing OMP session persistence. Do not add a second database for the first version.
- Preserve built-in Ask, approval mechanisms, goal controls, explicit stops, and cost limits.
- No automatic answers, default selection on timeout, unattended continuation loop, or polling turns.
- Document limitations of persistence and delivery acknowledgements instead of promising crash-proof exactly-once behavior.

## Scope

Version one supports top-level interactive OMP sessions, including sessions rendered by Tern. The OMP process must remain running for work to continue while the user is absent.

Subagents do not own separate user inboxes. They report missing decisions to their parent, which can create a question. Print/RPC/headless modes do not advertise the feature as usable: there is no supported answer transport in this version. An invocation that nevertheless reaches an unsupported context returns an explicit error without claiming to enqueue anything or falling back to a blocking dialog.

Out of scope: cross-session dashboards, remote answers, operating-system notification integrations, attachments in answers, persistent unsent drafts, automatic interpretation of arbitrary chat messages as answers, and replacement of OMP's goal scheduler.

## Existing integration points

Research was performed against repository revision `3f3906a583`.

| Need | Public integration |
| --- | --- |
| Model-facing tool | `ExtensionAPI.registerTool` |
| User command and shortcut | `registerCommand`, `registerShortcut`, `getShortcutConflict` |
| Inbox indicator | `ctx.ui.setWidget` with a component factory |
| Inbox UI | `ctx.ui.custom` and exported TUI components |
| Native Tern rendering | Component `describe`, `handleNativeEvent`, and native overlay metadata |
| Form parsing and validation | `@oh-my-pi/pi-tui/html-form/parse`, `/data`, `/dialog` |
| Session state | `appendEntry`, `ctx.sessionManager.getBranch/getEntries/getSessionId` |
| Answer messages | `sendMessage` with a custom message and `deliverAs: "aside"` |
| Delivery observation | `message_end` plus active transcript reconstruction |
| Restoration and isolation | Session start/switch/branch/tree/clear/compaction/shutdown events |
| Model awareness | Static prompt templates and existing extension context hooks |

OMP already includes extension widgets in Tern's native dock. `HtmlFormDialog` already renders native forms and handles native input. The plugin supplies semantic components through OMP; it does not create a second TSP connection or write escape sequences directly.

## Architecture

The package has five small responsibilities:

1. **Extension integration:** register the tool, command, optional shortcut, lifecycle hooks, and renderers.
2. **Question state:** validate events and reduce the active session history into an inbox snapshot.
3. **Answer delivery:** build identified answer envelopes, request delivery, and reconcile observations.
4. **Inbox UI:** show the indicator, select a question, collect an explicit answer, and display delivery state.
5. **Static prompts:** tool guidance, receipts, answer envelopes, and bounded pending-question context.

The UI and delivery layer use the same question state. Neither maintains a competing authoritative answer store. Parsing, validation, rendering primitives, logging, and sanitization reuse existing OMP utilities.

The standalone package's internal layout is:

- `src/index.ts`: extension registration and lifecycle wiring.
- `src/state.ts`: versioned event types, validation, reduction, and identity checks.
- `src/delivery.ts`: answer envelope preparation and delivery reconciliation.
- `src/ui.ts`: indicator and inbox components, sharing the built-in form component.
- `src/prompts/*.md`: static templates imported as text.
- `test/`: state, integration, and UI contract tests.

Source-package placement and installation are implementation-plan concerns; the runtime design does not depend on living inside the OMP repository. Compatibility is bounded to tested OMP versions, not every historical extension API.

## Model-facing contract

Register `ask_async` with explicit operations `create`, `list`, and `withdraw`. It must be discoverable through OMP's normal extension-tool mechanism. Do not shadow or replace `ask`.

### Create

Inputs:

- `title`: a short human-readable title.
- `html`: one HTML form using the existing Ask form vocabulary.
- `blockedWork`: a concise description of what depends on the answer.
- `continueWith`: optional descriptions of independent work; empty is valid when genuinely blocked.
- `key`: optional session-local logical identity for deduplication across model retries.

Validate the form before enqueueing. Reuse the shared parser and field model; do not invent a second HTML parser or validation language. A form must contain a usable named control. Unsupported markup follows the shared parser's behavior and never becomes executable HTML.

Bound inputs and queue growth. Initial implementation limits are 32 pending questions and 64 KiB UTF-8 per form; expose these as named plugin constants, not scattered literals. Exceeding either returns a clear error and preserves all existing questions. The tool must not evict old questions silently.

A successful call returns promptly after validation and local enqueueing, without awaiting a user interaction, an agent-idle condition, or answer delivery. Its structured result identifies the question and its pending state. Human-readable content explains that no answer has been given, that defaults are suggestions, and that independent work should continue.

Enqueueing success means the session accepted the question into its state. It is not a guarantee that every underlying persistence backend durably published it before the tool returned.

After creation, the question belongs to the session, not to a detached promise or the creating tool call's cancellation signal. Finishing that tool call must not dispose the question. An aborted call that already recorded creation is reconciled by identity rather than creating a second request on retry.

### Deduplication

Repeated execution of the same tool-call identity returns the original question ID with its current state, not a stale pending receipt. A matching logical `key` with identical creation content returns the existing request rather than creating another one. A reused key with different content returns a conflict; it does not overwrite a question the user may be reading.

Creation records include a stable request ID, tool-call identity, optional logical key, and normalized creation content. An explicitly withdrawn question can be replaced by a new request with a fresh ID. Retry handling must distinguish an identical retry of the old tool call from a new creation after withdrawal.

### List

Return IDs, titles, statuses, and blocked work from the active inbox. Full forms need not be repeated. This operation is for deliberate recovery or inspection, not periodic polling.

### Withdraw

Inputs are the question ID and a reason. Only an unanswered pending question can be withdrawn. Repeated withdrawal is idempotent. A submitted answer cannot be retracted by the model; it remains user input even if the work later becomes unnecessary.

No tool operation accepts a user answer, marks user approval, or impersonates submission.

## Question and delivery state

Keep question state separate from delivery progress:

- `pending`: no explicit user submission.
- `withdrawn`: no longer needed; includes the reason.
- `answered`: an explicit user answer exists.

An answered question has delivery progress:

- `submitted`: recorded in plugin session state, not yet dispatched.
- `queued`: a delivery call has been made for this answer in the current runtime.
- `recorded`: the matching answer message is present in the conversation.
- `unconfirmed`: a previous attempt cannot be confirmed after interruption or restoration.

`recorded` never means the model understood the answer, completed the dependent task, or performed the requested action.

Use versioned custom entries under a plugin-specific namespace. Record creation, withdrawal, explicit answer submission, and useful delivery observations. Each answer has its own stable answer ID. Include the owner session ID and request ID in every answer envelope.

Observe the actual answer message as the authority for `recorded`; a separate delivery-observation event alone is insufficient when the message is absent from the active path. This prevents a retained status marker from hiding a missing answer after history navigation.

Validate persisted events when rebuilding. Unknown versions or malformed plugin records surface a recoverable inbox error and are never interpreted as approvals. Preserve history rather than rewriting it in place.

## Inbox behavior

The idle indicator contains the pending count and an action to open the inbox. It may additionally flag unconfirmed answers. It does not claim the entire agent is waiting or replace the core working indicator.

`/questions` always provides an entry point. A shortcut may be registered only after checking conflicts; the plugin must not replace an existing binding. A shortcut is convenience, not a dependency.

The inbox defaults to pending questions in creation order. Answered and withdrawn history is available through a filter. Selection is stable when a new question arrives.

For the selected question show:

- Title and relative age.
- What work depends on the answer.
- Original form and relevant context.
- Submission/delivery state, or withdrawal reason.

Use a custom component that owns its form lifecycle. Reuse the exported `HtmlFormDialog` inside that component instead of invoking detached instances of the shared `ctx.ui.formDialog` surface. The built-in Ask implementation documents that its shared dialog slot has no queue; this plugin must not rely on concurrent use of that slot.

The custom overlay must honor OMP's focus and overlay lifecycle rather than taking over the editor or installing a global input interceptor. If another interactive surface supersedes it, retain the question and restore the inbox when the user reopens it.

Only an explicit Submit action creates an answer. Closing the inbox or its form leaves the question pending. Escape inside the inbox is consumed by the inbox and must not abort the running agent. Selecting a default and dismissing the form is not submission.

Do not set an inactivity timeout. Do not forward global Ask timeout settings. Unsaved drafts are not guaranteed to survive closing, session navigation, or process restart; tell the user when closing would discard edited input. Submitted answers remain available through ordinary session restoration.

If a pending question is withdrawn while its form is open, disable submission and show why it became obsolete. Recheck status and ownership immediately before accepting any answer.

Native Tern controls follow the terminal's semantic layout and theme. The ordinary-terminal fallback uses shared width, sanitization, path-display, and truncation utilities. Do not replace the global footer or editor just to display the inbox.

## Answer submission and delivery

Submission is handled serially per request:

1. Validate that the originating session and inbox generation are still current.
2. Recheck that the question remains pending and validate the entered values using shared form validation.
3. Assign an answer ID and append the submission event before requesting delivery.
4. Disable repeated submission of that request.
5. Prepare a custom message containing request/answer identities, the original question, blocked work, and the actual values and text notes submitted by the user.
6. Mark the in-memory attempt as queued before calling the delivery API, so immediate message events cannot race the bookkeeping.
7. Send with `display: true`, user attribution, and `deliverAs: "aside"`.
8. Reconcile the matching message event and active transcript to determine whether the answer is recorded.

Use a static template for model-visible answer context. Put machine-readable identities in message details as well. The question is agent-authored context; submitted values and notes are user-authored input. Do not attribute generated continuation instructions to the user.

An aside reaches the next eligible agent step without cancelling an executing tool batch. When idle, explicit submission can start one turn through the normal OMP path. Submission does not call goal or loop resume APIs, bypass a cost cap, or cancel existing tool execution.

`sendMessage` is fire-and-forget at the extension boundary. Catch synchronous failures and surface them, but do not assume every downstream failure can be observed. Message observation is evidence of conversation insertion, not a disk-write acknowledgement or provider-read receipt.

While a live attempt is queued, the UI does not offer repeated dispatch. At a settled lifecycle boundary, reconcile against the transcript; if no matching message is present and the original attempt is no longer live, expose unconfirmed delivery. After restart, a persisted submission without a corresponding message is also unconfirmed.

An unconfirmed answer stays visible with its contents. An explicit Retry reconciles again before sending the same answer identity. Explain that uncertain delivery cannot provide an exactly-once guarantee. Never automatically replay an unconfirmed answer at startup or in a timer loop.

In the normal single-runtime path, submission guards and answer identities prevent double clicks from producing two delivery calls. The design does not claim that the public runtime can deduplicate every message after an uncertain crash-window retry.

## Session and conversation isolation

Maintain a runtime generation token that changes on session replacement, history navigation, clear, and shutdown. UI callbacks capture their owner session and generation. Verify both before state changes and delivery. Dispose or close old UI on these transitions.

Reconstruct state from the active history path, respecting conversation reset boundaries. Mere absence from a compacted model prompt does not delete a persisted request.

- **Resume:** reconstruct pending questions, submitted answers, and observed messages. Do not start a turn because a question exists.
- **Session switch:** close the old inbox, invalidate callbacks, and rebuild for the new session. Never submit an old form into the new session.
- **Fork/new session:** inherited records owned by another session are historical context, not live requests. Do not deliver parent answers to the child. The child may create its own question.
- **Tree navigation/rewind:** rebuild from the selected path. An answer on an abandoned path is not automatically injected into the new path. A question still present on the selected path may be answered explicitly there.
- **Clear:** old questions remain in historical records but are not active in the cleared conversation. No automatic resurrection or delivery.
- **Compaction:** rebuild/retain plugin state and provide bounded pending-question context on subsequent model requests. Do not duplicate full forms in every request.
- **Shutdown:** close UI and release handlers; do not keep the process alive for an unanswered form or start a new agent turn during shutdown.

Public APIs do not expose a transactional session-bound send covering every navigation race. Session isolation remains an acceptance requirement, not an optional durability guarantee. If an affected delivery path cannot be made safe through public APIs, leave the answer unconfirmed and require explicit retry in a stable originating session; do not ship a known cross-session delivery path or guess a destination.

## Model behavior and prompt integration

Keep feature-specific guidance in the plugin's static prompt files so it is present only when the feature is usable. The user's APPEND_SYSTEM instruction can state the general persistence policy and refer to `ask_async` when available; do not require a tool that is not installed.

The guidance must distinguish:

- An obstacle the agent should investigate independently.
- A user decision genuinely needed for a particular dependency.
- Independent work that can continue while that dependency is unresolved.
- A state where no useful authorized independent work remains.

After enqueueing, the agent continues independent work rather than calling blocking Ask for the same question or polling `ask_async list`. It withdraws questions it resolves itself and processes answers when delivered.

A context hook can expose a bounded snapshot of pending IDs, titles, and dependencies during normal model calls, including after compaction. It must not generate its own turns. Recorded answers need not be reinjected as synthetic new user messages merely because context compacted.

Do not add an unconditional continuation hook, automatic goal resume, model-based blocker classifier, or watchdog that repeatedly spends tokens. The plugin cannot prove independent work exists. System instructions and goal implementation retain responsibility for appropriate continuation.

Never interpret missing input as authorization. Keep real tool approvals in OMP's approval system. Ask for protected credential references or locations rather than inviting users to paste secrets into persisted forms.

## Persistence guarantees and limitations

The first version has the same ordinary persistence environment as its host session, plus identified records that support reconciliation.

It does not provide:

- A transactional durable append acknowledged to the plugin.
- Atomic persistence of answer state and message queue admission.
- Exactly-once delivery across arbitrary crashes and manual retries.
- Proof that the provider received or acted on a recorded message.
- Continuation while the OMP process is stopped.
- Remote answering or a guaranteed answer surface in headless sessions.

`appendEntry()` returns void. Underlying persistence errors may be latched rather than thrown to the extension. `ensureOnDisk()` creates/materializes the session but is not a general flush guarantee. A separate delivery observation cannot repair missing underlying data after a crash.

Use honest UI wording: Pending, Submitted, Queued, Recorded in conversation, Delivery unconfirmed. Do not claim Saved to disk, Read by agent, or Guaranteed delivered.

## Verification plan

Tests exercise observable behavior, not implementation source text or prompt boilerplate.

### Core interaction

- Enqueue multiple questions and execute subsequent agent tools without answering any of them.
- Verify no default values become an answer through elapsed time, dismissal, or queued creation.
- Open/close the inbox while a long tool is running; that tool continues and completes normally.
- Submit an answer while a tool batch runs; the answer reaches the next eligible step without aborting the batch.
- Submit while idle; observe a normal answer-triggered turn without changing paused goal/loop modes.
- Double-submit and retry an identical creation; observe one normal-path question and one answer delivery attempt.
- Reject invalid or oversized forms and queue overflow without mutating existing questions.

### State and recovery

- Resume a session with pending questions and reconstruct the inbox without starting a turn.
- Restore an answer submission whose message is absent; expose unconfirmed delivery and preserve the submitted values.
- Restore a matching answer message; do not resend it.
- Withdraw a question while its form is open; stale submission is refused and the reason is visible.
- Switch session or navigate history during submission preparation; no answer enters the wrong session/path.
- Fork and clear; inherited or pre-clear questions do not become live inbox requests.
- Compact with pending questions; they remain answerable and visible to subsequent normal model context.
- Inject storage/delivery failures at supported test seams and verify that the plugin does not claim guarantees it cannot observe.

### User interfaces

- Exercise actual Tern native pointer selection, form editing, Submit, and inbox reopening through the OMP integration.
- Exercise ordinary-terminal keyboard navigation, validation, closing, resizing, and submission.
- Verify the inbox never replaces another pending question or steals focus when new requests arrive.
- Verify Escape closes the inbox without aborting the agent while the inbox owns focus. When another UI surface owns focus, verify the inbox does not intercept its keys or corrupt its lifecycle.
- Verify unsupported/headless/subagent contexts do not create invisible pending questions.
- Verify the absence of plugin timers or stop hooks that start repeated model turns while unanswered questions exist.

The end-to-end acceptance scenario is the user's overnight case: several genuine dependencies await answers; all independent work continues; the pending inbox survives ordinary resume; an eventual answer reaches the correct conversation without requiring the user to reconstruct the original question.

Implementation validation must include an actual Tern interaction before claiming native UI support verified. Source inspection establishes feasibility, not runtime proof.

## Source references

- `packages/coding-agent/src/extensibility/extensions/types.ts`: extension UI, tool registration, messaging, session-mode and lifecycle contracts.
- `packages/coding-agent/src/extensibility/shared-events.ts`: clear, branch, tree, compaction, and shutdown semantics.
- `packages/coding-agent/src/tools/ask.ts`: blocking execution, shared dialog exclusivity, timeouts, and existing form validation.
- `packages/coding-agent/src/modes/controllers/extension-ui-controller.ts`: widget mounting, shared forms, and extension delivery handlers.
- `packages/coding-agent/src/modes/interactive-mode.ts`: native dock inclusion of extension widgets.
- `packages/coding-agent/src/session/agent-session.ts`: aside delivery, session transitions, and queue admission.
- `packages/coding-agent/src/session/session-manager.ts`: custom entries, persistence behavior, reset boundaries, and read-only extension access.
- `packages/tui/src/tui.ts`: semantic component and native overlay contracts.
- `packages/tui/src/html-form/dialog.ts`: reusable HTML form rendering and input handling.
- `packages/tui/src/chat/messages.ts`: custom-message details and attribution.
- [Tern Plugin SDK](https://docs.stencil.so/tern/).
- [Tern Surface Protocol](https://docs.stencil.so/tern/protocol/index.md).
- [Tern Designing Views](https://docs.stencil.so/tern/guides/design.md).
