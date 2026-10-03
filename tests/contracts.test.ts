import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitTurn,
  assertAdmitted,
  InMemoryGuardrailStore,
  moderationDigest,
  RetryableToolError,
  runWithRetryBoundary,
  turnKey,
  type TurnInput,
  type ModerationReceipt,
} from '../src/index.js';
import { digest } from '../src/digest.js';

const input: TurnInput = {
  scopeId: 'owner/document',
  turnId: 'turn',
  policyVersion: 'v1',
  segments: [{ label: 'user', content: 'Rename it' }],
};

test('receipt reuses exact allowed input without re-moderation', async () => {
  const store = new InMemoryGuardrailStore();
  let calls = 0;
  const moderate = async () => {
    calls += 1;
    return true;
  };
  const first = await admitTurn({ store, input, moderate });
  assert.deepEqual(await admitTurn({ store, input, moderate }), first);
  await assertAdmitted(store, input);
  assert.equal(calls, 1);
});

test('receipt binds scope, turn, policy, label, whitespace and empty segments', async () => {
  const store = new InMemoryGuardrailStore();
  await admitTurn({ store, input, moderate: async () => true });
  for (const changed of [
    { ...input, scopeId: 'other' },
    { ...input, turnId: 'next' },
    { ...input, policyVersion: 'v2' },
    { ...input, segments: [{ label: 'other', content: 'Rename it' }] },
    { ...input, segments: [{ label: 'user', content: 'Rename it ' }] },
    { ...input, segments: [...input.segments, { label: 'extra', content: '' }] },
  ]) {
    await assert.rejects(assertAdmitted(store, changed), /does not match/);
  }
  await assert.rejects(
    admitTurn({
      store,
      input: { ...input, policyVersion: 'v2' },
      moderate: async () => {
        throw new Error('must not moderate');
      },
    }),
    /does not match/,
  );
});

test('denied receipts are immutable and never converted to allowed on retry', async () => {
  const store = new InMemoryGuardrailStore();
  await assert.rejects(admitTurn({ store, input, moderate: async () => false }), /denied/);
  await assert.rejects(
    admitTurn({
      store,
      input,
      moderate: async () => {
        throw new Error('must not moderate');
      },
    }),
    /denied/,
  );
});

test('parallel first admissions may duplicate provider calls but retain one immutable winner', async () => {
  const store = new InMemoryGuardrailStore();
  let calls = 0;
  const moderate = async () => {
    calls += 1;
    return true;
  };
  const [a, b] = await Promise.all([
    admitTurn({ store, input, moderate }),
    admitTurn({ store, input, moderate }),
  ]);
  assert.equal(calls, 2);
  assert.deepEqual(a, b);
});

test('invalid moderation response cannot authorize a turn', async () => {
  const store = new InMemoryGuardrailStore();
  await assert.rejects(
    admitTurn({ store, input, moderate: async () => 'yes' as unknown as boolean }),
  );
  assert.equal(await store.getReceipt(turnKey(input)), null);
});

test('canonical argument digest ignores object key order, never drops undefined or NaN', () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => digest({ hidden: undefined }), /finite JSON/);
  assert.throws(() => digest(NaN), /finite JSON/);
  assert.notEqual(
    moderationDigest(input),
    moderationDigest({ ...input, segments: [{ label: 'user', content: 'Rename it\n' }] }),
  );
});

test('argument identity rejects sparse arrays, cycles and hidden non-JSON state', () => {
  assert.throws(() => digest(new Array(1)), /dense JSON/);
  assert.throws(() => digest([1, , 3]), /dense JSON/);
  assert.throws(() => digest(Object.assign([], { hidden: true })), /dense JSON/);
  assert.throws(() => digest({ [Symbol('hidden')]: 'different' }), /dense JSON/);
  assert.throws(() => digest(Object.defineProperty({}, 'hidden', { value: 1 })), /dense JSON/);
  assert.throws(
    () =>
      digest({
        get dynamic() {
          throw new Error('Getter must not run');
        },
      }),
    /dense JSON/,
  );
  const cycle: unknown[] = [];
  cycle.push(cycle);
  assert.throws(() => digest(cycle), /acyclic JSON/);
  const shared = { label: 'A' };
  assert.equal(digest([shared, shared]), digest([{ label: 'A' }, { label: 'A' }]));
});

test('admission rejects ambiguous duplicate provenance labels before calling moderation', async () => {
  const store = new InMemoryGuardrailStore();
  let calls = 0;
  await assert.rejects(
    admitTurn({
      store,
      input: { ...input, segments: [...input.segments, { label: 'user', content: 'Hidden text' }] },
      moderate: async () => {
        calls += 1;
        return true;
      },
    }),
    /labels must be unique/,
  );
  assert.equal(calls, 0);
  assert.equal(await store.getReceipt(turnKey(input)), null);
});

test('cancellation during receipt persistence retains the decision but rejects admission', async () => {
  const controller = new AbortController();
  class CancellingStore extends InMemoryGuardrailStore {
    override async putReceiptIfAbsent(key: string, receipt: ModerationReceipt) {
      const saved = await super.putReceiptIfAbsent(key, receipt);
      controller.abort();
      return saved;
    }
  }
  const store = new CancellingStore();
  await assert.rejects(
    admitTurn({ store, input, signal: controller.signal, moderate: async () => true }),
    { name: 'AbortError' },
  );
  await assertAdmitted(store, input);
  await admitTurn({
    store,
    input,
    moderate: async () => {
      throw new Error('Saved receipt should be reused');
    },
  });
});

test('racing admission for altered text cannot inherit the winning decision', async () => {
  const store = new InMemoryGuardrailStore();
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const changed = admitTurn({
    store,
    input: { ...input, segments: [{ label: 'user', content: 'A different request' }] },
    moderate: async () => {
      started();
      await gate;
      return true;
    },
  });
  await entered;
  await admitTurn({ store, input, moderate: async () => true });
  release();
  await assert.rejects(changed, /does not match/);
  await assertAdmitted(store, input);
});

test('atomic mutation claims pick exactly one winner and fail closed for pending/unknown', async () => {
  const store = new InMemoryGuardrailStore();
  const call = { callId: 'write', name: 'rename', argsDigest: digest({ title: 'A' }) };
  const claims = await Promise.all(
    Array.from({ length: 16 }, () => store.claimMutation('turn', call)),
  );
  assert.equal(claims.filter((claim) => claim.status === 'acquired').length, 1);
  assert.equal(claims.filter((claim) => claim.status === 'pending').length, 15);
  const acquired = claims.find((claim) => claim.status === 'acquired')!;
  await assert.rejects(store.settleMutation('turn', 'wrong-token', { status: 'unknown' }));
  await store.settleMutation('turn', acquired.token, { status: 'unknown' });
  assert.deepEqual(await store.claimMutation('turn', call), { status: 'unknown' });
  await assert.rejects(
    store.settleMutation('turn', acquired.token, {
      status: 'complete',
      result: { content: 'success', status: 'success' },
    }),
  );
});

test('completed results replay only the same ID, tool and arguments; store values are detached', async () => {
  const store = new InMemoryGuardrailStore();
  const call = { callId: 'write', name: 'rename', argsDigest: digest({ title: 'A' }) };
  const claim = await store.claimMutation('turn', call);
  assert.equal(claim.status, 'acquired');
  if (claim.status !== 'acquired') throw new Error('Expected claim');
  await store.settleMutation('turn', claim.token, {
    status: 'complete',
    result: { content: 'done', status: 'success' },
  });
  assert.deepEqual(await store.claimMutation('turn', call), {
    status: 'replay',
    result: { content: 'done', status: 'success' },
  });
  for (const other of [
    { ...call, callId: 'new' },
    { ...call, name: 'delete' },
    { ...call, argsDigest: digest({ title: 'B' }) },
  ]) {
    assert.deepEqual(await store.claimMutation('turn', other), { status: 'conflict' });
  }
  const receipt = await admitTurn({ store, input, moderate: async () => true });
  receipt.allowed = false;
  await assertAdmitted(store, input);
});

test('inner retries never multiply with middleware retries, mutation defaults to one attempt', async () => {
  for (const options of [
    { policy: { owner: 'tool' as const, maxAttempts: 5 } },
    { mutation: true, policy: { maxAttempts: 5 } },
    {},
  ]) {
    let calls = 0;
    await assert.rejects(
      runWithRetryBoundary(async () => {
        calls += 1;
        throw new RetryableToolError('transient');
      }, options),
    );
    assert.equal(calls, 1);
  }
});

test('only explicit transient exceptions retry and idempotent mutation retries are bounded', async () => {
  let calls = 0;
  const result = await runWithRetryBoundary(
    async () => {
      calls += 1;
      if (calls < 3) throw new RetryableToolError('transient');
      return 'ok';
    },
    { mutation: true, policy: { maxAttempts: 3, idempotent: true } },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    runWithRetryBoundary(
      async () => {
        calls += 1;
        throw new Error('not classified');
      },
      { policy: { maxAttempts: 5 } },
    ),
  );
  assert.equal(calls, 1);
});

test('cancellation aborts backoff without retrying and skips pre-aborted work', async () => {
  const controller = new AbortController();
  let calls = 0;
  const running = runWithRetryBoundary(
    async () => {
      calls += 1;
      setTimeout(() => controller.abort(), 5);
      throw new RetryableToolError('transient');
    },
    { signal: controller.signal, policy: { maxAttempts: 5, delayMs: 10_000 } },
  );
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(
    runWithRetryBoundary(
      async () => {
        calls += 1;
      },
      { signal: controller.signal },
    ),
  );
  assert.equal(calls, 1);
});

test('retry helper preserves a known result after late cancellation for caller settlement', async () => {
  const controller = new AbortController();
  const result = await runWithRetryBoundary(
    async () => {
      controller.abort();
      return 'committed';
    },
    { signal: controller.signal, mutation: true },
  );
  assert.equal(result, 'committed');
  assert.throws(() => controller.signal.throwIfAborted(), { name: 'AbortError' });
});
