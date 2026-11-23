# omp-async-ask

Non-blocking questions with a session-local inbox for OMP. Native Tern controls and an ordinary-terminal fallback; no core patches or separate Tern plugin.

## Usage

From this directory:

```sh
omp plugin link .
```

Or load it for one session without installing:

```sh
omp -e ./src/index.ts
```

The agent's `ask_async` tool queues questions and returns immediately. Open `/questions`
or click the Questions widget: the first pending question is already expanded. Click a
card's chevron to switch; only one question opens at a time. Sending an answer opens
the next pending question. Skipped cards are amber, answered cards green; delivery
status remains separate from whether you answered.

“Skip for now” leaves the question pending. Switching cards preserves drafts while
the inbox stays open; closing it discards drafts after confirmation. New questions
never open the inbox or interrupt the question you are answering.

Ordinary terminals use Ctrl+Up/Down to switch questions, Escape to fold the form,
then arrows and Enter to select/expand cards. Escape outside a form closes the inbox.
Restart OMP after changing the linked source.

Only top-level interactive sessions are supported. Answers are stored in session
history, so do not enter secrets. Silence and preselected defaults are never submitted.
Built-in Ask, approvals, stops, and cost limits remain unchanged; the extension does
not force additional agent turns. It permits independent work but does not guarantee
that a model will choose to continue it.

The Questions button glows only for unanswered questions. Missing delivery receipts
do not add a notification count or imply that you must answer again. Actual send
failures show a separate warning; answers remain saved and resending is explicit.

With native Tern rendering, pending questions also mark the session icon as waiting.
The terminal chooses its waiting color (red in Tern 0.9.30). This uses a separate
[OSC 7501](https://www.superlogical.com/rex/docs/build/program-status) record:
agent work can continue, and answering or withdrawing the last question removes
only the inbox's status, leaving OMP's own work/approval status intact. The record
is also cleared on session changes, shutdown, or leaving native rendering.

Internally, a matching conversation receipt marks delivery as recorded—not proof
that the model read or acted on the answer. When a receipt is unavailable, delivery
details remain accessible inside the answered card. Resending may duplicate delivery;
the plugin never retries automatically. Public extension APIs do not provide
crash-proof exactly-once persistence or delivery.

## Development

Requires Bun 1.4.4 or newer and OMP 19.x.

```sh
bun install
bun run check
bun test ./test
bun test/manual-ui.ts
```

For the real-renderer regression check, launch `test/manual-ui.ts` in an isolated
Tern window, open the Retention policy form, then run:

```sh
bun test/tern-layout.ts <control-port>
```

The design and implementation records are in `docs/superpowers/`; their original
checkout paths describe the initial development location. The package now lives
independently of the OMP checkout. `test/tsp-harness.ts` is vendored from OMP under
its MIT license (see `LICENSE`) and imports only published package entrypoints.
