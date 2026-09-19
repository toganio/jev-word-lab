# Credential handling

TypeSafe keys are entered in a password field, held in browser memory, and sent to the same-origin `/api/decision` endpoint. The endpoint forwards the key only in the TypeSafe authorization header. It fixes the provider endpoint and `jev-latest` model, validates responses, and does not return upstream error bodies.

Keys are absent from the model state, experiment recorder, category export, WebMCP state, browser storage and repository configuration. The run-record sanitizer explicitly allows known fields and drops extra key/header properties. Tests cover key forwarding, sanitized errors, exports/record sanitization and rejection of other models.

The public classification snapshot contains only dictionary/schema information and numerical word assignments. It contains no private conversation logs, session identifiers or credentials. Its checksum is in `data/category-map-metadata.json`.

The hosted Site and its API routes remain protected by the Sites owner-only access gate. Making this repository public does not change that gate. A separate self-hosted deployment must provide its own authentication before exposing the API or experiment database.

## Pre-publication review, 2026-09-19

Reviewed the full available Git history (9 pre-update commits, 167 historical blobs), current source, the complete classification JSON, GitHub refs and attached resources. Searched for TypeSafe/OpenAI/GitHub/cloud keys, JWTs, private keys, hard-coded secret assignments, credential-bearing URLs and sensitive filenames. No secret matches were found. No additional branches, tags, releases, issues, comments, workflow runs or workflow artifacts were present.

Environment files, runtime output, local experiment reports and monitoring state are excluded from Git. Never add a real key to source, issues, screenshots, or an experiment prompt. Security checks describe the reviewed state, not a guarantee about future contributions.
