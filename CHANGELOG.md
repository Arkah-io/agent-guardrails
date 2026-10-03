# Changelog

## 0.1.0 — 2026-10-03

- `createDocumentGuardrails` middleware for LangChain `createAgent`: read-before-write, read-batch deferral, one mutation per logical turn, exact replay, unknown-outcome closure, and per-call authorization.
- `admitTurn` moderation receipts bound to exact labeled input, scope, turn and policy version.
- `runWithRetryBoundary` with explicit retry ownership and `RetryableToolError`.
- `GuardrailStore` contract with an in-memory reference adapter.
- Offline `createAgent` demo with a scripted model.

- Literal-true authorization, strict JSON mutation identities, duplicate-label rejection, and cancellation checks after storage operations.
- Clean-install consumer smoke test and public release workflow.
