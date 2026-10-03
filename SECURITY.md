# Security policy

This package is a correctness and authorization boundary for agent tool calls. Please report suspected bypasses privately; do not open a public issue.

Report through the repository's [private vulnerability form](https://github.com/Arkah-io/agent-guardrails/security/advisories/new). Include the policy you expected to hold, a minimal synthetic transcript or test, and the package and peer versions. Remove credentials and customer data from reproductions.

In scope:

- A mutation executing twice, executing without a fresh successful document read, or executing in the same model step as a read.
- A tool call running without `authorize`, or a forged transcript, receipt or client field granting authority.
- Admission reuse across changed input, scope, turn or policy.
- `InMemoryGuardrailStore` violating the documented storage contract within one process.

Out of scope: limits stated in the README (exactly-once side effects across the crash gap, prompt-injection isolation, behavior of custom storage adapters, and tools that ignore `AbortSignal`).

Supported versions: the latest patch of the `0.1.x` preview line. Security fixes are released there; no response-time guarantee is made.
