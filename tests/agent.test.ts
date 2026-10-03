import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, createAgent, tool } from 'langchain';
import { MemorySaver, Command, interrupt } from '@langchain/langgraph';
import type { ToolCall } from '@langchain/core/messages/tool';
import { z } from 'zod';
import {
  admitTurn,
  createDocumentGuardrails,
  InMemoryGuardrailStore,
  RetryableToolError,
  type ToolPolicy,
  type GuardrailStore,
  type MutationIdentity,
} from '../src/index.js';
import { ScriptedModel } from '../examples/scripted-model.js';

const readCall = (id = 'read'): ToolCall => ({ id, name: 'read', args: {} });
const writeCall = (id = 'write', title = 'New'): ToolCall => ({
  id,
  name: 'write',
  args: { title },
});
const step = (...tool_calls: ToolCall[]) => new AIMessage({ content: '', tool_calls });
const done = () => new AIMessage('Finished');

async function harness(
  options: {
    store?: GuardrailStore;
    turnId?: string;
    read?: () => Promise<string | ToolMessage | Command>;
    write?: () => Promise<string | ToolMessage | Command>;
    writePolicy?: ToolPolicy;
    readPolicy?: ToolPolicy;
    authorize?: (call: ToolCall) => Promise<boolean>;
  } = {},
) {
  const store = options.store ?? new InMemoryGuardrailStore();
  const input = {
    scopeId: 'user/doc',
    turnId: options.turnId ?? 'turn-1',
    policyVersion: 'v1',
    segments: [{ label: 'user', content: 'Rename this document' }],
  };
  await admitTurn({ store, input, moderate: async () => true });
  const effects = { reads: 0, writes: 0, auxiliary: 0, source: 0 };
  const tools = [
    tool(
      async () => {
        effects.reads += 1;
        return options.read ? await options.read() : '{"revision":0}';
      },
      { name: 'read', description: 'Read document', schema: z.object({}) },
    ),
    tool(
      async ({ title }) => {
        effects.writes += 1;
        return options.write ? await options.write() : title;
      },
      { name: 'write', description: 'Rename', schema: z.object({ title: z.string() }) },
    ),
    tool(
      () => {
        effects.auxiliary += 1;
        return 'saved';
      },
      { name: 'memory', description: 'Save preference', schema: z.object({}) },
    ),
    tool(
      () => {
        effects.source += 1;
        return 'source';
      },
      { name: 'source', description: 'Read source', schema: z.object({}) },
    ),
    tool(() => 'must be denied', {
      name: 'unregistered',
      description: 'Unregistered tool',
      schema: z.object({}),
    }),
  ];
  const middleware = createDocumentGuardrails({
    input,
    store,
    userMessageLabel: 'user',
    authorize: options.authorize ?? (async () => true),
    tools: {
      read: options.readPolicy ?? { kind: 'document-read' },
      write: options.writePolicy ?? { kind: 'mutation' },
      memory: { kind: 'auxiliary' },
      source: { kind: 'source-read' },
    },
  });
  const run = async (steps: AIMessage[], content = input.segments[0]!.content) => {
    const model = new ScriptedModel(steps);
    const agent = createAgent({ model, tools, middleware: [middleware] });
    const result = await agent.invoke({ messages: [new HumanMessage(content)] });
    return { result, model, results: result.messages.filter(ToolMessage.isInstance) };
  };
  return { store, input, tools, middleware, effects, run };
}

function codes(messages: ToolMessage[]): string[] {
  return messages.flatMap((message) => {
    try {
      const value = JSON.parse(String(message.content));
      return typeof value.guardrail === 'string' ? [value.guardrail] : [];
    } catch {
      return [];
    }
  });
}

test('real createAgent defers parallel read+write, preserves memory, then executes one mutation', async () => {
  const h = await harness();
  const { results, model } = await h.run([
    step(readCall(), writeCall('too-early'), { id: 'memory', name: 'memory', args: {} }),
    step(writeCall(), writeCall('second', 'Other')),
    step(writeCall('third')),
    done(),
  ]);
  assert.deepEqual(h.effects, { reads: 1, writes: 1, auxiliary: 1, source: 0 });
  assert.deepEqual(codes(results), ['read_batch_deferred', 'single_mutation', 'mutation_conflict']);
  assert.ok(
    model.seen[1]!.some((message) => ToolMessage.isInstance(message) && message.name === 'read'),
  );
});

test('mutation-only call is deferred until a successful document read in the current turn', async () => {
  const h = await harness();
  const { results } = await h.run([
    step(writeCall('early')),
    step(readCall()),
    step(writeCall()),
    done(),
  ]);
  assert.deepEqual(codes(results), ['read_required']);
  assert.equal(h.effects.writes, 1);
});

test('a failed read cannot unlock mutation', async () => {
  const h = await harness({
    read: async () => {
      throw new Error('secret detail');
    },
  });
  const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.equal(h.effects.writes, 0);
  assert.ok(codes(results).includes('read_required'));
});

test('source-read sibling always defers mutation even after a prior successful document read', async () => {
  const h = await harness();
  const { results } = await h.run([
    step(readCall()),
    step(writeCall('early'), { id: 'source', name: 'source', args: {} }),
    step(writeCall()),
    done(),
  ]);
  assert.equal(h.effects.source, 1);
  assert.equal(h.effects.writes, 1);
  assert.deepEqual(codes(results), ['read_batch_deferred']);
});

test('completed exact replay is cached; changed arguments and new call ID are blocked', async () => {
  const h = await harness();
  await h.run([step(readCall()), step(writeCall()), done()]);
  const exact = await h.run([step(readCall('retry-read')), step(writeCall()), done()]);
  assert.equal(h.effects.writes, 1);
  assert.equal(exact.results.at(-1)!.content, 'New');
  const changed = await h.run([
    step(readCall('read3')),
    step(writeCall('write', 'Changed')),
    done(),
  ]);
  assert.deepEqual(codes(changed.results), ['mutation_conflict']);
  const newId = await h.run([step(readCall('read4')), step(writeCall('new-id')), done()]);
  assert.deepEqual(codes(newId.results), ['mutation_conflict']);
  assert.equal(h.effects.writes, 1);
});

test('concurrent agent executions share an atomic mutation claim', async () => {
  let release!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await harness({
    write: async () => {
      entered();
      await gate;
      return 'done';
    },
  });
  const first = h.run([step(readCall('a')), step(writeCall()), done()]);
  await inside;
  const second = await h.run([step(readCall('b')), step(writeCall()), done()]);
  assert.deepEqual(codes(second.results), ['mutation_pending']);
  release();
  await first;
  assert.equal(h.effects.writes, 1);
});

test('unknown post-effect exception consumes the slot; no unsafe retry', async () => {
  const h = await harness({
    write: async () => {
      throw new RetryableToolError('response lost after write');
    },
    writePolicy: { kind: 'mutation', retry: { maxAttempts: 5 } },
  });
  const failed = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.deepEqual(codes(failed.results), ['mutation_unknown']);
  const replay = await h.run([step(readCall('again')), step(writeCall()), done()]);
  assert.equal(h.effects.writes, 1);
  assert.deepEqual(codes(replay.results), ['mutation_unknown']);
});

test('inner retry ownership is preserved in a real tool invocation', async () => {
  const h = await harness({
    read: async () => {
      throw new RetryableToolError('transient');
    },
    readPolicy: { kind: 'document-read', retry: { owner: 'tool', maxAttempts: 5 } },
  });
  await h.run([step(readCall()), done()]);
  assert.equal(h.effects.reads, 1);
});

test('middleware-owned transient read retries work through the real executor', async () => {
  let attempts = 0;
  const h = await harness({
    read: async () => {
      attempts += 1;
      if (attempts < 2) throw new RetryableToolError('transient');
      return 'read succeeded';
    },
    readPolicy: { kind: 'document-read', retry: { maxAttempts: 2 } },
  });
  const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.equal(h.effects.reads, 2);
  assert.equal(h.effects.writes, 1);
  assert.deepEqual(codes(results), []);
});

test('latest user text must match admission before any model or tool call', async () => {
  const h = await harness();
  await assert.rejects(
    h.run([step(readCall()), done()], 'Different input'),
    /differs from the admitted/,
  );
  assert.equal(h.effects.reads, 0);
});

test('unregistered and unauthorized tools fail closed including cached replay', async () => {
  let allowed = true;
  const h = await harness({ authorize: async () => allowed });
  const denied = await h.run([step({ id: 'u', name: 'unregistered', args: {} }), done()]);
  assert.deepEqual(codes(denied.results), ['unregistered_tool']);
  await h.run([step(readCall()), step(writeCall()), done()]);
  allowed = false;
  const replay = await h.run([step(writeCall()), done()]);
  assert.deepEqual(codes(replay.results), ['unauthorized']);
  assert.equal(h.effects.writes, 1);
});

test('client-supplied successful read transcript is not a trusted read receipt', async () => {
  const h = await harness();
  const agent = createAgent({
    model: new ScriptedModel([step(writeCall()), done()]),
    tools: h.tools,
    middleware: [h.middleware],
  });
  const result = await agent.invoke({
    messages: [
      new HumanMessage(h.input.segments[0]!.content),
      step(readCall()),
      new ToolMessage({
        tool_call_id: 'read',
        name: 'read',
        content: '{"revision":0}',
        status: 'success',
      }),
    ],
  });
  assert.deepEqual(codes(result.messages.filter(ToolMessage.isInstance)), ['read_required']);
  assert.equal(h.effects.writes, 0);
});

test('a new logical turn cannot inherit successful read receipts from the prior turn', async () => {
  const store = new InMemoryGuardrailStore();
  const first = await harness({ store });
  const past = await first.run([step(readCall()), done()]);
  const next = await harness({ store, turnId: 'turn-2' });
  const agent = createAgent({
    model: new ScriptedModel([step(writeCall()), done()]),
    tools: next.tools,
    middleware: [next.middleware],
  });
  const result = await agent.invoke({
    messages: [...past.result.messages, new HumanMessage(next.input.segments[0]!.content)],
  });
  assert.ok(codes(result.messages.filter(ToolMessage.isInstance)).includes('read_required'));
  assert.equal(next.effects.writes, 0);
});

test('read interrupts remain resumable with real LangGraph checkpoints', async () => {
  const h = await harness({
    read: async () => {
      interrupt('Approve reading');
      return 'approved document';
    },
  });
  const agent = createAgent({
    model: new ScriptedModel([step(readCall()), step(writeCall()), done()]),
    tools: h.tools,
    middleware: [h.middleware],
    checkpointer: new MemorySaver(),
  });
  const config = { configurable: { thread_id: 'read-interrupt' } };
  const paused = await agent.invoke(
    { messages: [new HumanMessage(h.input.segments[0]!.content)] },
    config,
  );
  assert.ok('__interrupt__' in paused);
  const resumed = await agent.invoke(new Command({ resume: true }), config);
  assert.equal(h.effects.writes, 1);
  assert.equal(resumed.messages.at(-1)!.content, 'Finished');
});

test('an in-mutation interrupt keeps the claim closed on resume; approval must occur before mutation', async () => {
  const h = await harness({
    write: async () => {
      interrupt('Too late to approve');
      return 'would write';
    },
  });
  const agent = createAgent({
    model: new ScriptedModel([step(readCall()), step(writeCall()), done()]),
    tools: h.tools,
    middleware: [h.middleware],
    checkpointer: new MemorySaver(),
  });
  const config = { configurable: { thread_id: 'mutation-interrupt' } };
  const paused = await agent.invoke(
    { messages: [new HumanMessage(h.input.segments[0]!.content)] },
    config,
  );
  assert.ok('__interrupt__' in paused);
  const resumed = await agent.invoke(new Command({ resume: true }), config);
  assert.ok(codes(resumed.messages.filter(ToolMessage.isInstance)).includes('mutation_unknown'));
  assert.equal(h.effects.writes, 1);
});

test('claim remains pending after a settlement-storage failure, preventing duplicate effects', async () => {
  class FailingSettlementStore extends InMemoryGuardrailStore {
    override async settleMutation(): Promise<void> {
      throw new Error('storage unavailable');
    }
  }
  const h = await harness({ store: new FailingSettlementStore() });
  await assert.rejects(h.run([step(readCall()), step(writeCall()), done()]), /storage unavailable/);
  const retried = await h.run([step(readCall('again')), step(writeCall()), done()]);
  assert.deepEqual(codes(retried.results), ['mutation_pending']);
  assert.equal(h.effects.writes, 1);
});

test('an already aborted invocation cannot execute a tool', async () => {
  const h = await harness();
  const controller = new AbortController();
  controller.abort();
  const agent = createAgent({
    model: new ScriptedModel([step(readCall()), step(writeCall()), done()]),
    tools: h.tools,
    middleware: [h.middleware],
  });
  await assert.rejects(
    agent.invoke(
      { messages: [new HumanMessage(h.input.segments[0]!.content)] },
      { signal: controller.signal },
    ),
  );
  assert.deepEqual(h.effects, { reads: 0, writes: 0, auxiliary: 0, source: 0 });
});

test('a new turn permits a new mutation only after its own successful read', async () => {
  const store = new InMemoryGuardrailStore();
  const first = await harness({ store });
  await first.run([step(readCall()), step(writeCall()), done()]);
  const next = await harness({ store, turnId: 'next-turn' });
  await next.run([step(readCall()), step(writeCall()), done()]);
  assert.equal(first.effects.writes + next.effects.writes, 2);
});

test('idempotent opt-in permits bounded mutation retries through the real executor', async () => {
  let attempts = 0;
  const h = await harness({
    write: async () => {
      attempts += 1;
      if (attempts < 2) throw new RetryableToolError('transient');
      return 'cached idempotent write';
    },
    writePolicy: { kind: 'mutation', retry: { maxAttempts: 2, idempotent: true } },
  });
  const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.equal(h.effects.writes, 2);
  assert.equal(results.at(-1)!.content, 'cached idempotent write');
});

test('authorization requires literal true rather than a truthy runtime value', async () => {
  for (const decision of ['false', 1, {}, undefined, null]) {
    const h = await harness({ authorize: async () => decision as unknown as boolean });
    const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
    assert.deepEqual(codes(results), ['unauthorized', 'unauthorized']);
    assert.equal(h.effects.reads, 0);
    assert.equal(h.effects.writes, 0);
  }
});

test('duplicate call IDs prevent every tool in the batch from executing', async () => {
  const h = await harness();
  const { results } = await h.run([
    step(readCall('same'), { id: 'same', name: 'memory', args: {} }),
    done(),
  ]);
  assert.deepEqual(codes(results), ['duplicate_call_id', 'duplicate_call_id']);
  assert.equal(h.effects.reads, 0);
  assert.equal(h.effects.auxiliary, 0);
});

test('editing a genuine successful-read result in the transcript does not unlock mutation', async () => {
  const h = await harness();
  const initial = await h.run([step(readCall()), done()]);
  const changed = initial.result.messages.slice(0, -1).map((message) =>
    ToolMessage.isInstance(message)
      ? new ToolMessage({
          tool_call_id: message.tool_call_id,
          name: message.name,
          content: 'Altered document',
          status: 'success',
        })
      : message,
  );
  const agent = createAgent({
    model: new ScriptedModel([step(writeCall()), done()]),
    tools: h.tools,
    middleware: [h.middleware],
  });
  const result = await agent.invoke({ messages: changed });
  assert.ok(codes(result.messages.filter(ToolMessage.isInstance)).includes('read_required'));
  assert.equal(h.effects.writes, 0);
});

test('an explicit error read result does not count as successful evidence', async () => {
  const h = await harness({
    read: async () =>
      new ToolMessage({ tool_call_id: 'read', content: 'Read failed', status: 'error' }),
  });
  const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.ok(codes(results).includes('read_required'));
  assert.equal(h.effects.writes, 0);
});

test('unsupported rich read results cannot unlock a mutation', async () => {
  const h = await harness({
    read: async () =>
      new ToolMessage({ tool_call_id: 'read', content: [{ type: 'text', text: 'Document' }] }),
  });
  const { results } = await h.run([step(readCall()), step(writeCall()), done()]);
  assert.deepEqual(codes(results), ['unsupported_result', 'read_required']);
  assert.equal(h.effects.writes, 0);
});

test('a mutation returning Command leaves an unknown claim and cannot run again', async () => {
  const h = await harness({ write: async () => new Command({ update: {} }) });
  const initial = await h.run([step(readCall()), step(writeCall()), done()]);
  const replay = await h.run([step(readCall('again')), step(writeCall()), done()]);
  assert.deepEqual(codes(initial.results), ['mutation_unknown']);
  assert.deepEqual(codes(replay.results), ['mutation_unknown']);
  assert.equal(h.effects.writes, 1);
});

test('explicit mutation error results consume the claim and replay without executing again', async () => {
  const h = await harness({
    write: async () =>
      new ToolMessage({ tool_call_id: 'write', content: 'Revision conflict', status: 'error' }),
  });
  await h.run([step(readCall()), step(writeCall()), done()]);
  const replay = await h.run([step(readCall('again')), step(writeCall()), done()]);
  assert.equal(replay.results.at(-1)!.status, 'error');
  assert.equal(replay.results.at(-1)!.content, 'Revision conflict');
  assert.equal(h.effects.writes, 1);
});

test('middleware persists a known mutation outcome before propagating late cancellation', async () => {
  const h = await harness();
  const history = await h.run([step(readCall()), done()]);
  const controller = new AbortController();
  const wrap = h.middleware.wrapToolCall!;
  let effects = 0;
  await assert.rejects(
    async () =>
      await wrap(
        {
          toolCall: writeCall(),
          tool: h.tools[1]!,
          state: { messages: [...history.result.messages.slice(0, -1), step(writeCall())] },
          runtime: { signal: controller.signal },
        },
        async () => {
          effects += 1;
          controller.abort();
          return new ToolMessage({
            tool_call_id: 'write',
            content: 'Committed before cancellation',
            status: 'success',
          });
        },
      ),
    { name: 'AbortError' },
  );
  const replay = await h.run([step(readCall('again')), step(writeCall()), done()]);
  assert.equal(effects, 1);
  assert.equal(h.effects.writes, 0);
  assert.equal(replay.results.at(-1)!.content, 'Committed before cancellation');
});

test('cancellation while loading a completed mutation cannot return a successful replay', async () => {
  const controller = new AbortController();
  class CancellingReplayStore extends InMemoryGuardrailStore {
    override async claimMutation(key: string, identity: MutationIdentity) {
      const claim = await super.claimMutation(key, identity);
      if (claim.status === 'replay') controller.abort();
      return claim;
    }
  }
  const h = await harness({ store: new CancellingReplayStore() });
  const history = await h.run([step(readCall()), step(writeCall()), done()]);
  await assert.rejects(
    async () =>
      await h.middleware.wrapToolCall!(
        {
          toolCall: writeCall(),
          tool: h.tools[1]!,
          state: { messages: [...history.result.messages, step(writeCall())] },
          runtime: { signal: controller.signal },
        },
        async () => {
          throw new Error('A replay must never execute');
        },
      ),
    { name: 'AbortError' },
  );
  assert.equal(h.effects.writes, 1);
});

test('cancellation during read receipt persistence propagates after preserving evidence', async () => {
  const controller = new AbortController();
  class CancellingReadStore extends InMemoryGuardrailStore {
    override async recordSuccessfulRead(key: string, evidence: string) {
      await super.recordSuccessfulRead(key, evidence);
      controller.abort();
    }
  }
  const h = await harness({ store: new CancellingReadStore() });
  await assert.rejects(
    async () =>
      await h.middleware.wrapToolCall!(
        {
          toolCall: readCall(),
          tool: h.tools[0]!,
          state: { messages: [new HumanMessage(h.input.segments[0]!.content), step(readCall())] },
          runtime: { signal: controller.signal },
        },
        async () =>
          new ToolMessage({ tool_call_id: 'read', content: 'Document', status: 'success' }),
      ),
    { name: 'AbortError' },
  );
});
