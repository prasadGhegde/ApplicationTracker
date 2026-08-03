# Opportunity Desk Workspace Instructions

These rules apply whenever an agent reads or updates this workspace.

## Opportunity Desk

1. Read `README.md` before changing the web application.
2. Keep Gmail access read-only. Do not add send, modify, trash, delete, or label API calls.
3. Never place OAuth credentials, tokens, email bodies, or OpenAI keys in source code, logs, reports outside `local-data/`, or test fixtures derived from real mail.
4. Credentials may come from environment variables or the owner-readable `local-data/runtime-credentials.json` file written by Settings. Keep that file gitignored. Keep the extractor behind `OpportunityExtractionService`.
5. OpenAI may perform structured opportunity extraction and short summarization only. Sync, deduplication, persistence, CRUD, metrics, timelines, and UI behavior remain deterministic application code.
6. Preserve raw `emails`, `app_settings`, OAuth state, and manual overrides during migrations.
7. A manual override must win over future extraction results until explicitly changed by the user.
8. After changes, run `npm run typecheck`, `npm test`, and `npm run build`.
