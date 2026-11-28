Queue a question for the user without waiting for an answer. Top-level interactive sessions only.

Use op=create with a short title, questions, and blockedWork naming exactly what requires the answer. Optional context is plain text (blank lines separate paragraphs) shown above the questions: evidence, findings, tradeoffs.

Each question has a unique identifier id (the answer key), a prompt, and a kind:
- single: pick one of options (default when options are given); multi: pick any of options. Give at least two options as {value, label?, detail?}. The user can always type their own answer instead, so never add an "Other" option.
- text (default without options), longtext, number: free input.

recommended preselects your suggestion (an option value, a list of values for multi, or a default for free input); it is a suggestion, never consent. required marks questions that must be answered. continueWith may identify independent work; omit it when none exists. key optionally identifies a logical question across retries.

Answers arrive as {id: value}: a value for single, a list for multi, text or number for free input.

Creation returns a question ID immediately. No answer has been given. Continue all useful independent work; do not ask the same question through blocking Ask, poll this tool, or pause the entire goal merely because one dependency is unanswered. Wait only when no useful authorized independent work remains.

The user opens /questions and explicitly submits an answer later. Answers arrive as identified conversation messages at an agent step boundary without cancelling executing tools. Process them when they arrive. Never invent an answer, infer approval from silence, or use this inbox to bypass real tool approvals. Ask for credential references, not secret values.

Use op=list only for deliberate recovery/inspection. Use op=withdraw with id and reason when a pending question no longer matters. Use op=answer with id and data ({id: value}, shaped as above) when you found the answer yourself; it closes the question as answered by the agent. Never answer what only the user can decide: approvals, consent, preferences, credentials. A changed question must be withdrawn and recreated, not silently replaced. Submitted answers cannot be withdrawn by the model.
