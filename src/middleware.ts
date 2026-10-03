import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  createMiddleware,
  type BaseMessage,
} from 'langchain';
import type { ToolCall } from '@langchain/core/messages/tool';
import { isGraphBubbleUp } from '@langchain/langgraph';
import {
  ClaimResultSchema,
  ToolPolicySchema,
  TurnInputSchema,
  type GuardrailStore,
  type MutationIdentity,
  type ToolPolicy,
  type TurnInput,
} from './contracts.js';
import { digest, turnKey } from './digest.js';
import { AdmissionError, assertAdmitted } from './moderation.js';
import { runWithRetryBoundary } from './retry.js';

export type DocumentGuardrailsOptions = {
  /** Construct from authenticated server state; never spread client/model data here. */
  input: TurnInput;
  store: GuardrailStore;
  tools: Record<string, ToolPolicy>;
  /** Label whose exact content must equal the latest text HumanMessage. */
  userMessageLabel: string;
  /** Reauthorize every concrete call, including reads, auxiliary calls and cached replay. */
  authorize: (call: ToolCall, input: TurnInput) => Promise<boolean>;
};

function identity(call: ToolCall): MutationIdentity {
  if (!call.id) throw new Error('Guarded tool calls require stable IDs');
  return { callId: call.id, name: call.name, argsDigest: digest(call.args) };
}

function readEvidence(call: ToolCall, result: ToolMessage): string {
  return digest({ ...identity(call), content: result.content, status: result.status ?? 'success' });
}

/** Stable key for an application-owned idempotent write service; the service must enforce it. */
export function mutationKey(input: TurnInput, call: ToolCall): string {
  return digest({ turn: turnKey(input), ...identity(call) });
}

function failure(call: ToolCall, code: string, message: string): ToolMessage {
  return new ToolMessage({
    name: call.name,
    tool_call_id: call.id ?? 'missing-id',
    status: 'error',
    content: JSON.stringify({ guardrail: code, message }),
  });
}

/**
 * Bind one middleware instance to one trusted logical turn. Pass it to createAgent.
 * @example const agent = createAgent({ model, tools, middleware: [createDocumentGuardrails(options)] });
 */
export function createDocumentGuardrails(options: DocumentGuardrailsOptions) {
  // Parse into detached objects so later caller mutations cannot change the policy.
  const input = TurnInputSchema.parse(options.input);
  const policies = new Map(
    Object.entries(options.tools).map(([name, policy]) => [name, ToolPolicySchema.parse(policy)]),
  );
  const { store, authorize } = options;
  const key = turnKey(input);
  const userSegments = input.segments.filter(
    (segment) => segment.label === options.userMessageLabel,
  );
  if (userSegments.length !== 1)
    throw new Error('userMessageLabel must identify exactly one segment');
  if (![...policies.values()].some((policy) => policy.kind === 'document-read')) {
    throw new Error('At least one document-read tool is required');
  }

  async function verify(messages: BaseMessage[], signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const human = messages.findLast((message) => HumanMessage.isInstance(message));
    if (!human || typeof human.content !== 'string' || human.content !== userSegments[0]!.content) {
      throw new AdmissionError('The latest user message differs from the admitted text segment');
    }
    await assertAdmitted(store, input);
    signal?.throwIfAborted();
  }

  async function hasFreshRead(messages: BaseMessage[]): Promise<boolean> {
    const humanIndex = messages.findLastIndex((message) => HumanMessage.isInstance(message));
    const latestAiIndex = messages.findLastIndex((message) => AIMessage.isInstance(message));
    const calls = new Map<string, ToolCall>();
    for (const message of messages.slice(humanIndex + 1, latestAiIndex)) {
      if (AIMessage.isInstance(message)) {
        for (const call of message.tool_calls ?? []) {
          if (call.id && policies.get(call.name)?.kind === 'document-read')
            calls.set(call.id, call);
        }
      }
      if (ToolMessage.isInstance(message) && message.status !== 'error') {
        const call = calls.get(message.tool_call_id);
        if (call && (await store.hasSuccessfulRead(key, readEvidence(call, message))) === true)
          return true;
      }
    }
    return false;
  }

  return createMiddleware({
    name: 'ArkahDocumentGuardrails',
    beforeAgent: async (state, runtime) => {
      await verify(state.messages, runtime.signal);
    },
    beforeModel: async (state, runtime) => {
      await verify(state.messages, runtime.signal);
    },
    wrapToolCall: async (request, handler) => {
      const { toolCall: call, runtime, state } = request;
      await verify(state.messages, runtime.signal);
      const policy = policies.get(call.name);
      if (!policy || call.name !== request.tool?.name || !call.id) {
        return failure(
          call,
          'unregistered_tool',
          'This tool call is not registered by server policy.',
        );
      }
      const lastAI = state.messages.findLast((message) => AIMessage.isInstance(message));
      const batch = AIMessage.isInstance(lastAI) ? (lastAI.tool_calls ?? []) : [];
      if (new Set(batch.map((item) => item.id)).size !== batch.length) {
        return failure(call, 'duplicate_call_id', 'Tool call IDs must be unique in a model step.');
      }
      if ((await authorize(structuredClone(call), structuredClone(input))) !== true) {
        return failure(call, 'unauthorized', 'Server authorization denied this tool call.');
      }
      runtime.signal?.throwIfAborted();
      const invoke = () =>
        runWithRetryBoundary(async () => await handler(request), {
          policy: policy.retry,
          mutation: policy.kind === 'mutation',
          signal: runtime.signal,
        });

      if (policy.kind !== 'mutation') {
        try {
          const result = await invoke();
          runtime.signal?.throwIfAborted();
          if (
            !ToolMessage.isInstance(result) ||
            typeof result.content !== 'string' ||
            result.artifact != null
          ) {
            return failure(
              call,
              'unsupported_result',
              'Guarded tools must return text ToolMessages without artifacts.',
            );
          }
          if (policy.kind === 'document-read' && result.status !== 'error') {
            await store.recordSuccessfulRead(key, readEvidence(call, result));
          }
          runtime.signal?.throwIfAborted();
          return result;
        } catch (error) {
          if (isGraphBubbleUp(error)) throw error;
          runtime.signal?.throwIfAborted();
          // Application logs may capture error details. Do not leak server errors to the model.
          return failure(
            call,
            'tool_failed',
            'The tool failed. No successful document read was recorded.',
          );
        }
      }

      if (
        !batch.some(
          (item) => item.id === call.id && digest(identity(item)) === digest(identity(call)),
        ) ||
        batch.some((item) => {
          const kind = policies.get(item.name)?.kind;
          return kind === 'document-read' || kind === 'source-read';
        })
      ) {
        return failure(
          call,
          'read_batch_deferred',
          'This mutation has not run. Read results must reach the model before a new mutation call.',
        );
      }
      const firstMutation = batch.find((item) => policies.get(item.name)?.kind === 'mutation');
      if (firstMutation?.id !== call.id) {
        return failure(
          call,
          'single_mutation',
          'Only the first document mutation in a model step is eligible. Auxiliary calls still run.',
        );
      }
      if (!(await hasFreshRead(state.messages))) {
        return failure(
          call,
          'read_required',
          'This mutation has not run. Call a document-read tool successfully, inspect its result, then request the mutation again.',
        );
      }
      runtime.signal?.throwIfAborted();
      const claim = ClaimResultSchema.parse(await store.claimMutation(key, identity(call)));
      if (claim.status !== 'acquired') runtime.signal?.throwIfAborted();
      if (claim.status === 'replay') {
        return new ToolMessage({ ...claim.result, name: call.name, tool_call_id: call.id });
      }
      if (claim.status !== 'acquired') {
        return failure(
          call,
          `mutation_${claim.status}`,
          claim.status === 'conflict'
            ? 'This logical turn already owns a different mutation. Start a new user turn for another edit.'
            : 'A mutation is pending or its outcome is unknown. Reconcile the document on the server before continuing; do not assume it failed.',
        );
      }

      let result;
      try {
        runtime.signal?.throwIfAborted();
        result = await invoke();
        if (
          !ToolMessage.isInstance(result) ||
          typeof result.content !== 'string' ||
          result.artifact != null
        ) {
          throw new Error('Mutation returned an unsupported result');
        }
      } catch (error) {
        // Exceptions and cancellation after claiming cannot prove a write did not happen.
        await store.settleMutation(key, claim.token, { status: 'unknown' });
        if (isGraphBubbleUp(error)) throw error;
        runtime.signal?.throwIfAborted();
        return failure(
          call,
          'mutation_unknown',
          'The mutation outcome is unknown. Server reconciliation is required before another edit.',
        );
      }
      // Persist a known outcome even if cancellation arrived after the operation returned.
      // If this write fails, the pending claim stays closed; never run the mutation again.
      await store.settleMutation(key, claim.token, {
        status: 'complete',
        result: { content: result.content, status: result.status ?? 'success' },
      });
      runtime.signal?.throwIfAborted();
      return result;
    },
  });
}
