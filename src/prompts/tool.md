Queue a question for the user without waiting for an answer. Top-level interactive sessions only.

Use op=create with a short title, one HTML <form>, and blockedWork naming exactly what requires the answer. Use the same plain semantic form vocabulary as Ask: named inputs, selects and textareas, labeled controls, fieldsets for groups. No scripts, styles or submit buttons. Recommended values are suggestions, never consent. continueWith may identify independent work; omit it when none exists. key optionally identifies a logical question across retries.

Creation returns a question ID immediately. No answer has been given. Continue all useful independent work; do not ask the same question through blocking Ask, poll this tool, or pause the entire goal merely because one dependency is unanswered. Wait only when no useful authorized independent work remains.

The user opens /questions and explicitly submits an answer later. Answers arrive as identified conversation messages at an agent step boundary without cancelling executing tools. Process them when they arrive. Never invent an answer, infer approval from silence, or use this inbox to bypass real tool approvals. Ask for credential references, not secret values.

Use op=list only for deliberate recovery/inspection. Use op=withdraw with id and reason when a pending question no longer matters. A changed question must be withdrawn and recreated, not silently replaced. Submitted answers cannot be withdrawn by the model.
