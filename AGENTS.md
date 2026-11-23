# Repository privacy rules

This repository is published publicly. Treat every commit, including its metadata and deleted file versions, as public.

- Never commit private infrastructure domains, hostnames, server aliases, internal IP addresses, private repository or service URLs, personal filesystem paths, local usernames, credentials, tokens, private keys, or real session data.
- This applies to source, documentation, plans, prompts, configuration, tests, fixtures, filenames, commit messages, generated assets, screenshots, and embedded image metadata. Historical notes and examples are not exceptions.
- Never reproduce actual private values in a committed denylist, audit report, or this rule file. Describe categories instead. Use relative paths, placeholders such as `<artifacts>`, reserved example domains, and synthetic test data.
- Explicitly approved public GitHub attribution and upstream license notices are allowed. Do not remove required attribution or infer permission to publish any other identifying information.
- Keep private operational configuration and rollback backups outside the published repository. Do not copy local Git configuration, dependency directories, caches, credentials, or session journals into release artifacts.
- Before committing or pushing, inspect the complete staged diff and any new asset metadata for private information. Before a public release, scan all reachable Git history for credentials and private identifiers; a cleanup commit alone does not remove earlier disclosures.
- If private information is found, stop publication and report the finding privately. Do not publish it in an issue or pull request. Obtain authorization before rewriting shared history; rotate exposed credentials when applicable, then rescan the final publishable refs.
