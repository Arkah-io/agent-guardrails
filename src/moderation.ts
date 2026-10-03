import {
  ModerationReceiptSchema,
  TurnInputSchema,
  type GuardrailStore,
  type ModerationReceipt,
  type TurnInput,
} from './contracts.js';
import { digest, turnKey } from './digest.js';

export class AdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdmissionError';
  }
}

export function moderationDigest(input: TurnInput): string {
  return digest({ version: 1, ...TurnInputSchema.parse(input) });
}

function verifyReceipt(receipt: unknown, input: TurnInput): ModerationReceipt {
  const parsed = ModerationReceiptSchema.safeParse(receipt);
  if (
    !parsed.success ||
    parsed.data.scopeId !== input.scopeId ||
    parsed.data.turnId !== input.turnId ||
    parsed.data.policyVersion !== input.policyVersion ||
    parsed.data.digest !== moderationDigest(input)
  ) {
    throw new AdmissionError('Stored admission does not match the exact logical turn input');
  }
  if (!parsed.data.allowed) throw new AdmissionError('This logical turn was denied at admission');
  return parsed.data;
}

/**
 * Reuse a stored decision for transport retries; changed text or policy needs a new turn ID.
 * @example await admitTurn({ store, input, moderate: async segments => providerAllows(segments) });
 */
export async function admitTurn(options: {
  store: GuardrailStore;
  input: TurnInput;
  moderate: (segments: TurnInput['segments'], signal?: AbortSignal) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<ModerationReceipt> {
  const input = TurnInputSchema.parse(options.input);
  options.signal?.throwIfAborted();
  const key = turnKey(input);
  const prior = await options.store.getReceipt(key);
  options.signal?.throwIfAborted();
  if (prior) return verifyReceipt(prior, input);
  const allowed = await options.moderate(structuredClone(input.segments), options.signal);
  options.signal?.throwIfAborted();
  const candidate = ModerationReceiptSchema.parse({
    version: 1,
    scopeId: input.scopeId,
    turnId: input.turnId,
    policyVersion: input.policyVersion,
    digest: moderationDigest(input),
    allowed,
  });
  const receipt = await options.store.putReceiptIfAbsent(key, candidate);
  options.signal?.throwIfAborted();
  return verifyReceipt(receipt, input);
}

/** Load from trusted storage; a model/client-supplied receipt is never an authority. */
export async function assertAdmitted(store: GuardrailStore, input: TurnInput): Promise<void> {
  verifyReceipt(await store.getReceipt(turnKey(input)), input);
}
