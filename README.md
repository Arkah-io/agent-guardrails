# arkah-agent-guardrails

## One user turn, one document mutation

An agent can call the right editing tool and still make the wrong change. It can edit before reading the document, send two edits in parallel, repeat a write after losing the response, or multiply an expensive tool's internal retries with another retry loop.

These failures have a common feature: the application needs a rule that survives the model's next response. A prompt saying “edit once” cannot provide that rule. A server-owned mutation claim can.

`arkah-agent-guardrails` is a small TypeScript middleware pack for **LangChain `createAgent`, built on LangGraph**. It binds one trusted logical user turn to a document scope and enforces the contracts around reads, writes, retries, and accepted moderation decisions. It comes with a working offline agent demo and a storage interface for durable deployments.

**Status:** v0.1.0 preview, independently maintained. ESM only. CI is configured for Node 20, 22 and 24 against the lockfile floor below, with a separate weekly job for newer compatible peer releases. This is not an official LangChain integration.

| Peer                   | Tested floor | Accepted range |
| ---------------------- | ------------ | -------------- |
| `langchain`            | 1.5.15       | `^1.5.15`      |
| `@langchain/core`      | 1.2.14       | `^1.2.14`      |
| `@langchain/langgraph` | 1.4.18       | `^1.4.18`      |
| `zod`                  | 4.6.5        | `^4.6.5`       |

### Is this for you?

Use it if your agent edits a document, record or file on a user's behalf, and duplicate or blind edits are worse than a refused tool call. Skip it for read-only agents. Skip it too if your agent is supposed to make many edits per request. In that case use LangChain's built-in call-limit middleware with an idempotent write service.

## Install

```sh
pnpm add arkah-agent-guardrails langchain@^1.5.15 @langchain/core@^1.2.14 @langchain/langgraph@^1.4.18 zod@^4.6.5
```

Source and issues: [Arkah-io/agent-guardrails](https://github.com/Arkah-io/agent-guardrails).

## Run the small demo

From this repository, with Node 20+ and pnpm 9.1:

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm demo` runs a real `createAgent` loop with a scripted model, local tools, and this middleware. It requires no API key, network call, model download, or account. Only the model responses and moderation decision are stubbed. The tool execution, parallel batches, middleware, replay, and assertions are real.

The model first requests a read, a rename, and a memory update together. The rename waits until a later model step. Then it requests two renames; only the first is eligible. A later third rename is refused. Finally the demo retries the accepted mutation and receives its stored result.

The observed trace includes:

```text
read_document [success]: {"title":"Untitled","revision":0}
rename_document [error]: read_batch_deferred
remember [success]: Preference saved
rename_document [success]: {"title":"Field notes","revision":1}
rename_document [error]: single_mutation
rename_document [error]: mutation_conflict

--- transport retry ---
read_document [success]: {"title":"Field notes","revision":1}
rename_document [success]: {"title":"Field notes","revision":1}

writes: 1
moderationCalls: 1
```

The retried rename still carries `expectedRevision: 0` while the document is at revision 1. Executing it again would throw, so its success shows the stored result was replayed. The example checks the write count, moderation count and replayed result, and fails if any of them change. Read the complete [demo](examples/document-agent.ts), including its document revision check.

## Why the read has to finish before the next model step

Parallel tool execution makes a subtle bug easy to miss:

```text
model: [read_document(), rename_document({ title: "New" })]
```

Even if the read finishes first, the rename arguments were chosen before the model saw its result. The middleware therefore returns a clear “has not run” tool error for every mutation in a batch containing a document or source read. It leaves reads and auxiliary calls in the transcript and executes them normally. The model must request its edit in a later step.

A mutation also needs a successful document read since the latest admitted user message. A transcript containing a plausible `ToolMessage` does not prove that a read happened. The wrapper records successful read evidence in trusted storage and checks it against an earlier tool call and result in the current turn. Failed reads and earlier turns do not qualify.

This is provenance, not a lock on the document. Another user may edit after the read. The write service must check `expectedRevision` or use an equivalent database compare-and-set. The demo makes that distinction concrete.

## The mutation claim survives more than one model response

Every mutation competes for one slot keyed by `(scopeId, turnId)`. The first eligible call claims it atomically. The identity includes the tool-call ID, tool name, and a canonical digest of its JSON arguments.

| Situation                                                 | Result                                                |
| --------------------------------------------------------- | ----------------------------------------------------- |
| Several mutations in one model response                   | Only the first is eligible; auxiliary calls still run |
| Another mutation in a later response                      | Refused because the turn already owns a mutation      |
| Same completed call, same arguments                       | Return its stored text result; do not execute again   |
| Same call ID, changed arguments                           | Refused                                               |
| Concurrent execution of an already pending call           | Refused; no second executor gets ownership            |
| Exception after claiming, or interruption inside mutation | Outcome becomes unknown; no automatic rerun           |
| Process dies, or storing the result fails                 | Pending claim remains closed                          |

An error consumes the slot too. Allowing a different mutation after an ambiguous error would be an easy way to perform the write twice.

**This does not claim exactly-once side effects.** A process may write the document and die before saving the result. This package deliberately stops at that uncertainty. A production host must reconcile the operation and prevent new turns from editing that resource until it is resolved. Exactly-once behavior across that gap needs a shared transaction or an idempotency mechanism in the write service. A checkpointer alone does not provide it.

## Small API, explicit ownership

There are three main steps:

1. Construct `TurnInput` from authenticated server state, with a server-issued turn ID and code-owned segment labels.
2. Call `admitTurn` at the admission boundary and persist its decision in `GuardrailStore`.
3. Create middleware bound to that same input, store, tool registry, and concrete authorization callback.

In an application that already has its model, tools, authorization, and moderation service:

```ts
import { createAgent } from 'langchain';
import { admitTurn, createDocumentGuardrails } from 'arkah-agent-guardrails';

// input, store, model and tools are supplied by your trusted server.
await admitTurn({ store, input, moderate: moderateSegments });

const guardrails = createDocumentGuardrails({
  input,
  store,
  userMessageLabel: 'user',
  authorize: authorizeConcreteResource,
  tools: {
    read_document: { kind: 'document-read' },
    fetch_source: { kind: 'source-read' },
    rename_document: { kind: 'mutation' },
    remember: { kind: 'auxiliary' },
  },
});

const agent = createAgent({
  model,
  tools,
  middleware: [guardrails],
});
```

This snippet shows integration points; the [offline example](examples/document-agent.ts) supplies every dependency and runs as-is. To consume the local build elsewhere, run `pnpm pack` and install the resulting `.tgz` with pnpm. No registry publication is required.

The middleware checks the exact latest text `HumanMessage` against the named segment before model and tool execution. It loads the stored admission itself. Passing a receipt in a tool argument, graph history, or request context grants no authority. `authorize` runs for every concrete tool call, including cached replay. The underlying service must still authorize the resource immediately before reading or writing it.

Register every exposed tool. Unknown tools fail closed. `auxiliary` means the tool does not mutate the guarded document; it is not a loophole for an extra document write. Memory side effects need their own authorization and idempotency rules. A fresh user request gets a fresh trusted turn ID; a transport retry keeps the original one. Use one middleware instance per logical turn.

## Moderation once at admission, with exact-input reuse

A receipt contains the scope, logical turn, policy version, and digest of the exact ordered, labeled segments. Empty segments and whitespace are preserved. Reusing the stored decision requires all of them to match; changing the user text, provenance label, scope, turn, or policy does not silently inherit approval. Denied decisions are stored too.

`admitTurn` reuses an existing matching decision without calling the provider. Two simultaneous first admissions can still both call the provider; atomic insert-if-absent chooses one immutable receipt. This package does not promise coalescing of concurrent moderation requests. Add a preparation reservation at admission if your service needs it.

The application owns the moderation policy and provider. The demo's `true` callback is intentionally just a stub. A receipt is neither authentication nor prompt-injection isolation. Additional source, document, and memory content still needs appropriate untrusted-data boundaries. The host must extract all relevant user-controlled segments and freeze the full accepted request; this middleware only compares the configured user message to the graph transcript.

New user-controlled text received through `Command.resume`, an edited tool approval, or another human-in-the-loop answer requires a new admitted input and logical turn. The middleware cannot discover text hidden inside arbitrary resume payloads. A boolean approval that changes no admitted content may resume the same turn.

## Retry ownership avoids multiplication

The default is one attempt. Mark a tool with `retry: { owner: 'tool' }` if it already retries internally. This wrapper will not add another loop.

For a retryable read, opt in to a bounded policy:

```ts
read_document: {
  kind: 'document-read',
  retry: { owner: 'middleware', maxAttempts: 3, delayMs: 100 },
}
```

Only a thrown `RetryableToolError` opts an operation into retry. Ordinary exceptions, explicit error `ToolMessage`s, cancellations, and graph control-flow signals do not trigger retry. Attempts are capped at five. Sleeps are abortable.

Mutations stay at one attempt unless `retry.idempotent: true` is explicitly set. That declaration is a promise about your write service, not an implementation of idempotency. Use `mutationKey(input, call)` as a stable operation key and enforce it in the side-effecting service. Never layer another generic tool retry around a guarded mutation; that loop could run inside the claimed operation and defeat its retry policy. Auxiliary writes deserve the same care.

LangChain already ships [tool retry and call-limit middleware](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in). This package adds the document-specific relationship between accepted input, earlier read evidence, mutation identity, and an uncertain outcome. Its hooks use the official [custom middleware API](https://docs.langchain.com/oss/javascript/langchain/middleware/custom).

## Cancellation, checkpoints, and honest boundaries

- Cancellation is cooperative. It prevents new attempts and cancels backoff, but cannot undo a write or forcibly stop a tool that ignores the signal. Known results are stored before propagating late cancellation; ambiguous exceptions leave an unknown claim.
- Read and auxiliary LangGraph interrupts propagate normally and can resume with a checkpointer. Put human approval **before** entering a mutation. An interrupt inside a mutation preserves the graph pause but leaves the claim unknown; resuming refuses to rerun it.
- The v0.1 contract accepts text `ToolMessage` results without artifacts. Tools returning `Command`, rich content, or artifact payloads need an application adapter. A mutation returning an unsupported result leaves its claim unknown.
- Model/tool-call IDs and the full admitted request must survive checkpoint or transport replay. The same edit under a new call ID is a different mutation and is refused.
- All mutations require a document read, including initially empty documents. The first release favors a small, conservative rule over target-specific exceptions.
- Graph/model iteration limits remain the application's responsibility. These policies stop extra document effects; they do not guarantee that a model stops asking for them.

`InMemoryGuardrailStore` is safe for concurrent calls **within one process using the same instance**. It loses everything on restart and has no eviction. It is for the demo and tests. Production needs a durable adapter implementing [the atomic storage contract](docs/storage-adapters.md). No production database driver is bundled in this release.

## Tests and contributing

```sh
pnpm lint
pnpm check
pnpm test
pnpm build
pnpm demo
pnpm smoke:package
```

The tests exercise real `createAgent` calls and LangGraph checkpoints, concurrent mutation claims, same-call replay, changed arguments, forged read history, failed reads, authorization, pending writes after storage failure, moderation binding, retry ownership, and cancellation. The package smoke test installs a fresh tarball, type-checks its public declarations, and runs the real agent demo against the installed package.

The [community contribution draft](docs/community-proposal.md) describes a possible LangChain integration and the review questions that still need maintainer input.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under [MIT](LICENSE).

## Background

Originally developed at [Arkah](https://arkah.io) for agents that edit documents.
