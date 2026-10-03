# Durable storage adapter contract

The supplied adapter is in memory. This document specifies the requirements for a production adapter; it is not a claim that a database driver has been implemented.

## Data and scope

`turnKey(input)` hashes `(scopeId, turnId)`. Policy version is intentionally excluded from the key: changing policy must not mint a second mutation slot for the same user turn. The receipt binds policy separately. Scope and turn identifiers come from authenticated server state and durable admission, never model arguments or client ownership fields.

Mutation argument digests accept plain JSON data with finite numbers. Sparse arrays, cycles, accessors, symbol properties, and hidden properties are rejected so distinct in-memory arguments cannot collapse to the same stored identity. Ordinary object key order does not affect the digest. Use the package's `mutationKey` helper instead of constructing an operation key from string concatenation.

Persist three kinds of record:

| Record             | Unique key                 | Immutable evidence                                                       |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| Moderation receipt | turn key                   | scope, turn, policy, input digest, allowed decision                      |
| Successful read    | turn key + evidence digest | tool ID, name, canonical argument digest, exact returned text and status |
| Mutation           | turn key                   | identity, claim token, pending/complete/unknown state, completed result  |

The interface lives in [`GuardrailStore`](../src/contracts.ts). Its methods must return detached, validated values; mutable row objects must not leak to callers.

## Atomic operations

`putReceiptIfAbsent` must atomically insert or return the existing receipt. A losing writer never overwrites an allowed or denied decision. The caller checks the winner against its exact input. Concurrent initial requests may still duplicate provider work before insertion.

`claimMutation` must atomically perform the following:

1. With no row, insert pending ownership and return a new unguessable claim token.
2. With another identity, return conflict.
3. With the same identity and pending or unknown status, return that status without ownership.
4. With the same identity and a completed result, return the stored result.

A transaction with a unique primary key and conflict handling can implement this. A `SELECT` followed by an unprotected `INSERT` cannot. Claims must be linearizable across all workers, replicas, and retrying clients for that turn.

`settleMutation` is a compare-and-set from pending, requiring both the turn key and exact claim token. It stores either the complete text result or unknown status. A failed settlement must not release ownership or permit re-execution. Repeated settlement, the wrong token, and a settlement against an absent row must fail.

`recordSuccessfulRead` is an idempotent insert. `hasSuccessfulRead` must observe completed inserts consistently before allowing a mutation. A stale read that misses evidence may conservatively defer a mutation; false positive evidence is forbidden.

Return actual booleans from `hasSuccessfulRead`; only literal `true` grants read evidence. The same rule applies to the middleware's authorization callback. Database strings such as `"false"` and numeric flags must be converted explicitly by the adapter.

Cancellation does not roll back a completed storage operation. If cancellation arrives while a receipt is being saved, admission rejects but retains the saved decision for a later retry. Known mutation outcomes are settled before propagating late cancellation. This avoids converting a confirmed write into an ambiguous one merely because its observer disconnected.

## The write/receipt crash gap

The middleware cannot include an arbitrary external side effect in its storage transaction:

```text
claim pending → invoke tool → document updated → process dies → result missing
```

Do not reclaim pending writes after a timeout. A timeout proves that a response is missing, not that a write failed. The same holds for unknown status, process crashes, and in-tool interrupts. A lease that permits another executor needs a fencing/idempotency design at the write service, beyond this interface.

Reconcile through a trusted administrative workflow: inspect the operation's business record or idempotency key, establish its actual outcome, and decide how to represent recovery to the user. Block new edits to that resource while unresolved. The middleware enforces one slot per turn; it does not implement a resource-wide lock across different turns.

If stronger guarantees are needed, atomically persist the document update and operation result in the same database transaction, or make the destination accept the stable `mutationKey`. An idempotency flag alone is insufficient.

## Retention and trust

Retain claims and receipts for as long as a replay can arrive. Deleting a completed row while its turn ID can still be replayed reopens the mutation slot. Once results are expired, retain a refusal tombstone or invalidate the turn at admission. The in-memory adapter intentionally does no automatic eviction.

The database boundary is trusted. Restrict writes to authenticated application workers; do not expose these methods as agent tools or client-callable endpoints. Store receipts with the frozen admitted request. Digest equality authenticates neither the caller nor the bytes' origin by itself.

## Adapter verification

Reuse the store tests with your adapter and add process-level concurrent tests. Verify racing different claims, exact completed replay, altered arguments, wrong settlement tokens, failed settlement, immutable conflicting receipts, receipt retention, successful-read visibility, cancellation during persistence, and connection-loss behavior. A real database adapter must also test transaction isolation and crash recovery; the single-process tests cannot prove those properties.
