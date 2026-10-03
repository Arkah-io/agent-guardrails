import { randomUUID } from 'node:crypto';
import {
  ModerationReceiptSchema,
  MutationIdentitySchema,
  MutationSettlementSchema,
  type ClaimResult,
  type GuardrailStore,
  type ModerationReceipt,
  type MutationIdentity,
  type MutationSettlement,
} from './contracts.js';
import { digest } from './digest.js';

type MutationRecord = {
  identity: MutationIdentity;
  token: string;
  settlement?: MutationSettlement;
};

/** Single-process demo adapter. Data disappears on restart; no eviction is safe during a turn. */
export class InMemoryGuardrailStore implements GuardrailStore {
  private readonly receipts = new Map<string, ModerationReceipt>();
  private readonly reads = new Map<string, Set<string>>();
  private readonly mutations = new Map<string, MutationRecord>();

  async getReceipt(key: string): Promise<ModerationReceipt | null> {
    return structuredClone(this.receipts.get(key) ?? null);
  }

  async putReceiptIfAbsent(key: string, receipt: ModerationReceipt): Promise<ModerationReceipt> {
    const candidate = ModerationReceiptSchema.parse(receipt);
    const existing = this.receipts.get(key);
    if (existing) return structuredClone(existing);
    this.receipts.set(key, candidate);
    return structuredClone(candidate);
  }

  async recordSuccessfulRead(key: string, evidence: string): Promise<void> {
    const reads = this.reads.get(key) ?? new Set<string>();
    reads.add(evidence);
    this.reads.set(key, reads);
  }

  async hasSuccessfulRead(key: string, evidence: string): Promise<boolean> {
    return this.reads.get(key)?.has(evidence) ?? false;
  }

  async claimMutation(key: string, identity: MutationIdentity): Promise<ClaimResult> {
    const candidate = MutationIdentitySchema.parse(identity);
    const prior = this.mutations.get(key);
    if (prior) {
      if (digest(prior.identity) !== digest(candidate)) return { status: 'conflict' };
      if (!prior.settlement) return { status: 'pending' };
      if (prior.settlement.status === 'unknown') return { status: 'unknown' };
      return { status: 'replay', result: structuredClone(prior.settlement.result) };
    }
    // No await between lookup and insert: atomic within this JS process only.
    const token = randomUUID();
    this.mutations.set(key, { identity: candidate, token });
    return { status: 'acquired', token };
  }

  async settleMutation(key: string, token: string, settlement: MutationSettlement): Promise<void> {
    const record = this.mutations.get(key);
    if (!record || record.token !== token || record.settlement) {
      throw new Error('Mutation settlement requires the pending claim token');
    }
    record.settlement = MutationSettlementSchema.parse(settlement);
  }
}
