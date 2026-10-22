# Development and publishing

This repository contains public source and synthetic demo assets only. Never
commit account JSON, login snapshots, tokens, databases, local reports, usage
caches, private paths or screenshots made from real accounts. Generate public
screenshots with `npm run screenshots`, which always uses the demo backend.

Keep WorkBuddy Switch branding and the upstream credit in README and
THIRD_PARTY_NOTICES.md. Preserve third-party license notices.

Do not stop, restart, switch or modify a user's live WorkBuddy or CodeBuddy
client during development. Process-control tests must use isolated temporary
profiles, synthetic credentials and fixture databases. Preserve conversations,
editor state, deletion flags and unrelated storage on switches and rollbacks.

Do not add external model gateways or forward credentials to third-party
services. Model tests use the official service only, after an explicit test
click or a user changing the overview model selection. Changing that selection
tests each eligible account once; loading, refreshing and restoring a saved
selection must never trigger inference.
Keep credentials in the main process and private export files, never renderer
state, logs or screenshots. Never log secret values during validation.

Run unit tests, build, synthetic UI checks and public-file checks before
publishing. Release archives must include only the application and runtime,
never the development workspace or a user's profile.
