# Non-blocking Ask Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an installable OMP extension that queues questions immediately and accepts answers through a non-blocking, Tern-native session inbox.

**Architecture:** A session-backed question store owns requests and submissions. A delivery coordinator identifies custom answer messages and guards session generations. An extension-owned inbox reuses HtmlFormDialog and renders through OMP's native component contract, with a terminal fallback.

**Tech Stack:** TypeScript, Bun, OMP ExtensionAPI, pi-tui forms/native components, omptype schemas, static Markdown prompt templates, Bun tests.

**Spec:** `docs/superpowers/specs/2026-11-22-non-blocking-ask-design.md`

## Global Constraints

- Standalone installable OMP extension package; no OMP core patches, monkey-patches, private API access, or direct transcript-file mutations.
- One OMP plugin provides both native Tern UI and an ordinary-terminal fallback. No separate Tern plugin, browser server, external messaging service, or daemon.
- Session-local inbox, opened explicitly by the user. New questions never open dialogs or steal focus.
- Use existing OMP session persistence. Do not add a second database for the first version.
- Preserve built-in Ask, approval mechanisms, goal controls, explicit stops, and cost limits.
- No automatic answers, default selection on timeout, unattended continuation loop, or polling turns.
- Initial implementation limits are 32 pending questions and 64 KiB UTF-8 per form.
- No claim of crash-proof exactly-once delivery or provider-read acknowledgement.
- New code lives under `packages/coding-agent/examples/extensions/async-ask/`; this is a self-contained package, not a core feature. Its package manifest uses the existing `omp.extensions` convention.
- The main session owns implementation and acceptance. Work on `feat/async-ask-plugin`, preserve unrelated untracked files, and do not commit without an explicit user request (repository command rule).
- Use public source exports already available in this checkout. Do not add dependencies to OMP's root manifest or lockfile.
- Use `bun check` for type verification, never a direct tsc invocation. Run package-local tests and targeted formatting/lint checks.

---

## Files and interfaces

Package root: `packages/coding-agent/examples/extensions/async-ask` (abbreviated `PLUGIN` below).

- `package.json`: installable package metadata, exports and OMP extension entrypoint.
- `src/state.ts`: question data, validated session events, creation/deduplication/submission/withdrawal, and replay.
- `src/delivery.ts`: session-generation guards and custom-message reconciliation.
- `src/ui.ts`: native indicator and inbox, terminal keyboard handling, HtmlFormDialog composition.
- `src/index.ts`: ExtensionAPI wiring, tool schema, commands, lifecycle and context hooks.
- `src/prompts/{tool,receipt,answer,context}.md`: all model-facing guidance and dynamic text templates.
- `test/{state,delivery,ui,extension}.test.ts`: observable contracts.
- `test/helpers.ts`: typed in-memory session journal and extension/runtime seams.
- `test/manual-ui.ts`: deterministic local UI fixture for real PTY/Tern acceptance, no model or network credentials.

Exported data interfaces from `state.ts`:

```ts
interface CreateQuestion {
  title: string;
  html: string;
  blockedWork: string;
  continueWith?: string[];
  key?: string;
}
type DeliveryState = "submitted" | "queued" | "recorded" | "unconfirmed";
interface SubmittedAnswer {
  id: string;
  data: HtmlFormData;
  notes: AnswerNote[];
}
interface AnswerNote {
  name: string;
  question: string;
  option: string;
  value: string;
  text: string;
}
interface Question extends CreateQuestion {
  id: string;
  sessionId: string;
  toolCallId: string;
  createdAt: number;
  status: "pending" | "answered" | "withdrawn";
  reason?: string;
  answer?: SubmittedAnswer;
  delivery?: DeliveryState;
}
```

`QuestionStore` constructor takes a session ID and a synchronous event-append callback. It exposes `create(input, toolCallId): Question`, `withdraw(id, reason): Question`, `submit(id, data, notes): Question`, `get(id): Question | undefined`, `list(): readonly Question[]`, `restore(entries: readonly SessionEntry[]): void`, `observe(message: AgentMessage): boolean`, and `setDelivery(id, state): void`. It exposes replay errors without accepting malformed events. Persistence callback failure must precede in-memory mutation.

`AnswerDelivery` takes the store plus a narrow port with current-session/idle queries and custom-message delivery. It exposes `submit(id, data, notes)`, `retry(id)`, `observe(message)`, `settle()`, and `dispose()`. Its owner is fixed at construction; stale callbacks fail rather than reroute. Its message details contain request, answer and owner-session IDs. No method waits for an agent turn.

The UI consumes an `InboxActions` interface: get current questions/errors, submit/retry, subscribe to changes, and close. It knows no ExtensionAPI session internals. The integration layer closes the current UI and replaces the store/delivery owner on lifecycle changes.

## Task 1: Session-backed state and installable package

**Files:** Create `PLUGIN/package.json`, `PLUGIN/src/state.ts`, `PLUGIN/test/helpers.ts`, `PLUGIN/test/state.test.ts`.

**Consumes:** Public SessionEntry and AgentMessage types, HtmlFormData, parseHtmlForm/fieldError, pi-utils validation helpers.

**Produces:** CreateQuestion, Question, AnswerNote, QuestionStore, versioned QuestionEvent, plugin custom-type constants.

- [x] Write failing behavioral tests with a journal callback that builds real-shaped custom SessionEntry values. Use a valid required radio form, then exercise distinct contracts:

```ts
const store = new QuestionStore("session-a", journal.append);
const first = store.create({ title: "Target", html: requiredRadio, blockedWork: "deploy" }, "call-1");
expect(store.create({ title: "Target", html: requiredRadio, blockedWork: "deploy" }, "call-1").id).toBe(first.id);
store.withdraw(first.id, "Resolved independently");
expect(store.create({ title: "Target", html: requiredRadio, blockedWork: "deploy" }, "call-1").status).toBe("withdrawn");
```

- [x] Test invalid forms, conflicting logical keys, pending limit, oversized HTML, required-field rejection, explicit zero/unchecked values, double submission, withdrawal during answering, corrupted replay, foreign-session records, and reset boundaries. Each test asserts a user-visible state or surfaced error.
- [x] Run `bun test ./packages/coding-agent/examples/extensions/async-ask/test/state.test.ts` and record the missing-feature failure.
- [x] Implement validation, synchronous persist-before-mutate operations and replay. Use UUIDs for request/answer identities. Restore submissions as unconfirmed unless matching custom messages exist on the active path. Ignore foreign-owner records and pre-reset events. Do not use timers.
- [x] Add a package manifest using `"omp": { "extensions": ["./src/index.ts"] }`, source files in `files`, and peer dependencies for the OMP packages imported at runtime. No root install changes.
- [x] Run the state contract tests and correct failures before integration.

## Task 2: Non-interrupting answer delivery and lifecycle guards

**Files:** Create `PLUGIN/src/delivery.ts`, `PLUGIN/src/prompts/answer.md`, `PLUGIN/test/delivery.test.ts`.

**Consumes:** QuestionStore and its data types; a typed delivery port; pi-utils prompt rendering.

**Produces:** AnswerDelivery and its port, identified custom answer messages, synchronous lifecycle methods.

- [x] Write failing tests for queue-before-send observation races, normal single delivery, rejection of a stale owner, synchronous send failure, settle without an observed message, and explicit retry after restore.

```ts
const question = store.create(input, "call-1");
delivery.submit(question.id, { target: "staging" }, []);
expect(store.get(question.id)?.delivery).toBe("queued");
expect(port.sent[0]?.options.deliverAs).toBe("aside");
delivery.observe(port.asRecordedMessage(0));
expect(store.get(question.id)?.delivery).toBe("recorded");
```

- [x] Run the delivery tests and record the expected missing-feature failure.
- [x] Implement explicit user submission, answer preparation from the static Markdown template, and identified `sendMessage` delivery. Set queued state before invoking the port. Include user attribution and distinguish agent-written question context from submitted values.
- [x] Retry only explicitly, with the same answer identity, after rechecking the active transcript and owner. Never retry a currently queued attempt. Dispose invalidates callbacks; it never aborts a tool or resumes a goal.
- [x] Test a simulated busy tool with Promise.withResolvers: submitting an answer must return while that tool remains unresolved. Resolve the tool later and observe the message at the simulated step boundary.
- [x] Run state and delivery tests together.

## Task 3: Native inbox with ordinary-terminal fallback

**Files:** Create `PLUGIN/src/ui.ts`, `PLUGIN/test/ui.test.ts`, `PLUGIN/test/manual-ui.ts`.

**Consumes:** Question/AnswerNote, InboxActions, public Component/Focusable, HtmlFormDialog, native node helpers, sanitization/formatting helpers.

**Produces:** QuestionIndicator and QuestionInbox components usable through `setWidget` and `ui.custom`.

- [x] Write failing component tests asserting pending/answered filtering, stable selection when a request arrives, withdrawal disabling submission, Escape handling, and semantic native action routing.

```ts
inbox.handleInput("\u001b");
expect(actions.closed).toBe(true);
expect(actions.submissions).toEqual([]);
```

- [x] Run UI tests and record the expected missing-feature failure.
- [x] Implement a native indicator button and a compact terminal line. Both open the same inbox through the supplied callback; no focus stealing on state updates.
- [x] Implement the inbox list/detail flow using existing native node builders, a clear close/back action, history filtering, and shared sanitized terminal rendering. Compose HtmlFormDialog as a child so native input targets reach its state machine directly.
- [x] Implement explicit discard confirmation for forms, no form timeout, and serial submission/retry actions. Disable or replace obsolete selected forms on store updates without accepting stale input.
- [x] Wire focus forwarding, redraw/disposal, and overlay metadata. Never install a global input hook or overwrite the core editor/footer.
- [x] Build the deterministic manual fixture around a real TUI and the same plugin components. Seed two questions and a continuing work indicator; persist events only within the fixture's memory. Native rendering is exercised through Tern's normal handshake.
- [x] Run the component tests and capture a real PTY interaction using the `tui` tool.

## Task 4: Extension wiring and end-to-end acceptance

**Files:** Create `PLUGIN/src/index.ts`, `PLUGIN/src/prompts/tool.md`, `PLUGIN/src/prompts/receipt.md`, `PLUGIN/src/prompts/context.md`, `PLUGIN/test/extension.test.ts`; update the plan checkboxes and implementation evidence.

**Consumes:** All prior task interfaces and OMP ExtensionAPI.

**Produces:** Installable plugin whose tool, inbox, answer delivery and restoration work together.

- [x] Write an extension harness that captures registration and invokes real registered tool handlers with a typed interactive context and session journal. Assert creation finishes without opening UI and a subsequent independent operation executes while questions remain pending.
- [x] Test user command opening, stale inbox callbacks after switch, clear-boundary replay, unsupported contexts, bounded context injection after restoration, and absence of automatic answer delivery on resume.
- [x] Run extension tests and record the missing-feature failure.
- [x] Register the tool using the injected schema builder; runtime guards enforce top-level interactive mode. Tool execution returns plain structured details and statically templated text. Prompt instructions stay in Markdown files.
- [x] Register `/questions`; use the same opener for the widget. Avoid a default shortcut if choosing one would collide. Keep no detached dialog promises tied to the creating tool call.
- [x] Subscribe to lifecycle events, observe custom messages, and rebuild state from the current branch. Before session/tree transitions, invalidate the UI owner; after transition, restore the new owner. A cancelled transition must leave the current session recoverable through reopening.
- [x] Add bounded pending-question context through the normal context hook. Do not register a stop-hook continuation or call sessionModes.set.
- [x] Run all plugin tests together, format/lint only the plugin, and run `bun check` using the repository-supported scoped typecheck path. Record exact unrelated/toolchain failures rather than claiming a global pass.
- [x] Use `tui` for a real PTY and Tern CLI for an isolated headless window. Exercise native form click/edit/submit and verify the work indicator continues while questions are unanswered. Clean up only owned test processes.
- [x] Inspect the archive generated by `bun pm pack` into a temporary directory. Confirm entrypoint and Markdown templates are included and test fixtures are excluded.
- [x] Review final changes for lost answers, duplicate dispatch, session ownership, focus interference, uncontrolled turns, secret logging and unsupported API assumptions. Preserve unrelated changes and report source path, installation command, tests, native UI evidence and remaining limitations.

## Plan self-review

- Spec coverage: all tool operations, queue/input bounds, forms, native/fallback UI, lifecycle isolation, static prompts, unsupported modes, packaging and acceptance scenarios map to Tasks 1–4.
- Type consistency: QuestionStore owns persisted question state; AnswerDelivery owns only delivery attempts and lifecycle validity; UI uses InboxActions and never writes history directly.
- Deliberate limitations: persistence acknowledgement and exactly-once delivery are not introduced by tests or UI wording; no standalone behavior depends on a core patch.
- Execution: user has already requested execution. Proceed inline without another approval question. Do not modify installed plugin settings or claim user-environment installation unless explicitly performed and verified.

## Implementation and verification evidence

- Implemented the standalone `omp-async-ask` package, usage instructions in the existing examples README, and the coding-agent unreleased changelog entry. No core implementation changes or installed plugin configuration changes.
- `bunx --package bun@1.4.4 bun test ./packages/coding-agent/examples/extensions/async-ask/test`: **27 passed, 0 failed, 86 assertions**. Includes a real `Agent` loop executing independent work after two unanswered questions and native TSP form-event roundtrips.
- `bunx --package bun@1.4.4 bun check --no-script -p packages/coding-agent/examples/extensions/async-ask/tsconfig.json`: **no type errors in 2,831 files**.
- Targeted `oxfmt` formatted 10 TypeScript files; targeted `oxlint --no-ignore` exited successfully.
- Final review found that replay checked answer shape but not required/unknown form fields. Both regression cases failed before the correction; the state suite then passed all 12 cases. Live and restored submissions now share semantic validation.
- Real terminal fixture: queued two questions, edited and submitted `{"target":"staging"}`, and observed one pending question plus recorded history while independent work continued.
- Actual isolated Tern renderer: clicked Questions, Answer, text input, Submit, and History. It recorded `{"target":"staging"}` at work step 136; work reached step 157 with the inbox still open. Screenshot: `<artifacts>/async-ask-acceptance/serve/async-ask-native-history.png`. The original fixture's help line used row fallback; the inbox and form were native. The final fixture gives the help line a native description too.
- Installed OMP **19.1.0** loaded the extension using `--no-extensions -e <plugin>/src/index.ts`. Both the native widget and `/questions` opened the real custom overlay without a model request during those checks. Screenshot: `<artifacts>/async-ask-acceptance/serve/async-ask-installed-omp.png`.
- A later fixture relaunch incorrectly reached the still-running OMP composer rather than its shell and triggered an unintended model turn. Stopped its fixture tool and closed the isolated Tern window; process inspection found no remaining acceptance processes. This mistake is separate from the successful loader and native-form checks.
- `bun pm pack --ignore-scripts --destination <artifacts>/async-ask-acceptance` produced `omp-async-ask-0.1.0.tgz`: nine files, including the entrypoint and all four Markdown templates, excluding tests.
- Toolchain notes: global Bun 1.4.2 lacks the required built-in scoped check behavior; validation used cached Bun 1.4.4 without upgrading the global installation. Rebuilt the checkout's stale native binding with `bun run build:native`; no tracked native artifacts changed.
- Deliberate limits remain: top-level interactive sessions only; no forced continuation; answers persist in session history; “recorded” is not model-read acknowledgement; recovery is explicit and cannot guarantee crash-proof exactly-once delivery.
- Work remains on `feat/async-ask-plugin`, uncommitted under the repository's no-commit-without-request rule. Existing `.codegraph/` and `tool-views.generated.js` were preserved.

## Follow-up: native radio-label overlap

- User-reported screenshot exposed a collision missed by the initial text-field acceptance. Tern 0.9.30 applies `.sf-overlay[data-role^='omp.overlay.'] .sf-ov-card .sf-list .sf-item { padding: 0 10px; }`, overriding Ask's 38px marker gutter.
- Changed only the plugin-owned overlay role to `async-ask.inbox`, avoiding the core OMP overlay skin. No stylesheet injection, terminal configuration changes, core patches, or form-state rewrites.
- Added `test/tern-layout.ts`, a live-renderer geometry check. With the retention radio form open, `bun packages/coding-agent/examples/extensions/async-ask/test/tern-layout.ts <control-port>` failed on overlapping labels before the fix and passed afterward in both light and dark appearance.
- Actual pointer selection and submission recorded `{"days":"30"}` at work step 49; independent work reached step 98 with history still open. Screenshot: `<artifacts>/async-ask-radio-fixed/serve/radio-fixed-dark.png`.
- Final verification: 27 tests passed, 86 assertions; scoped typecheck passed across 2,832 files; formatting and 95 lint rules passed across 11 files.
- The installed plugin is linked to this checkout. Restart OMP to load the updated module.
