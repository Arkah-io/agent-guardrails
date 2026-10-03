# Draft: document mutation middleware for the LangChain community

## Proposed contribution

A standalone JavaScript integration and technical walkthrough: **One user turn, one document mutation**. The package targets `createAgent` middleware on LangGraph. It is not a middleware adapter for arbitrary `StateGraph` nodes.

LangChain's existing call-limit and retry middleware are useful primitives. Document editing adds a relationship those primitives do not express alone: one accepted user input, a successful earlier document read, one atomic mutation identity, and a result that may need replay after a transport retry.

The proposal is to share those policies with a runnable example that needs no API key.

## Reviewable behavior

- A mutation paired with a read is deferred until the next model step, independent of parallel scheduling.
- Auxiliary memory calls survive that deferral.
- A turn can own one mutation; completed exact replays return the cached result.
- Pending or ambiguous writes remain closed, with a documented reconciliation boundary.
- Retry ownership is explicit; mutation retry requires application-enforced idempotency.
- Admission receipts come from trusted storage and bind exact labeled inputs and policy.
- Read interrupts work with real LangGraph checkpoint/resume; approvals must occur before a mutation begins.

The demo and integration tests use `createAgent` directly. There is no mocked tool executor, provider key, or hosted dependency.

## Questions for maintainers

1. Would the read-before-write policy be useful as a standalone middleware recipe or as an external integration package?
2. Is there an established convention for trusted logical-turn identity and durable tool-result replay that this interface should follow?
3. Should the first upstream discussion focus on deterministic batch deferral and auxiliary preservation, with durable ownership documented as an optional adapter?
4. How should the community example explain unsupported interrupts inside a mutation without implying that checkpoints provide exactly-once side effects?

## Submission path

Follow the current [LangChain integration publishing guide](https://docs.langchain.com/oss/javascript/contributing/publish-langchain) and discuss scope with maintainers before opening a broad framework change. Start with a short issue or discussion linking the runnable demo, tests, and explicit limitations in [Arkah-io/agent-guardrails](https://github.com/Arkah-io/agent-guardrails). The npm package name is `arkah-agent-guardrails`.

A maintainer-approved docs recipe or integration listing is a plausible first goal. Community acceptance and feature placement are decisions for LangChain maintainers; this draft makes no endorsement claim.
