import { z } from 'zod';

const IdentifierSchema = z.string().min(1).max(256);
export const TurnScopeSchema = z.object({
  scopeId: IdentifierSchema,
  turnId: IdentifierSchema,
  policyVersion: IdentifierSchema,
});
export type TurnScope = z.infer<typeof TurnScopeSchema>;

export const SegmentSchema = z.object({ label: IdentifierSchema, content: z.string() });
export const TurnInputSchema = TurnScopeSchema.extend({
  segments: z.array(SegmentSchema).min(1),
}).superRefine((input, context) => {
  const labels = new Set<string>();
  input.segments.forEach((segment, index) => {
    if (labels.has(segment.label)) {
      context.addIssue({
        code: 'custom',
        path: ['segments', index, 'label'],
        message: 'Code-owned segment labels must be unique',
      });
    }
    labels.add(segment.label);
  });
});
export type TurnInput = z.infer<typeof TurnInputSchema>;

export const ModerationReceiptSchema = TurnScopeSchema.extend({
  version: z.literal(1),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  allowed: z.boolean(),
});
export type ModerationReceipt = z.infer<typeof ModerationReceiptSchema>;

export const MutationIdentitySchema = z.object({
  callId: IdentifierSchema,
  name: IdentifierSchema,
  argsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MutationIdentity = z.infer<typeof MutationIdentitySchema>;

// Small text-only results make durable replay portable across storage adapters.
export const StoredToolResultSchema = z.object({
  content: z.string(),
  status: z.enum(['success', 'error']),
});
export type StoredToolResult = z.infer<typeof StoredToolResultSchema>;

export const MutationSettlementSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('complete'), result: StoredToolResultSchema }),
  z.object({ status: z.literal('unknown') }),
]);
export type MutationSettlement = z.infer<typeof MutationSettlementSchema>;

export const ClaimResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('acquired'), token: IdentifierSchema }),
  z.object({ status: z.literal('replay'), result: StoredToolResultSchema }),
  z.object({ status: z.enum(['pending', 'unknown', 'conflict']) }),
]);
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

export const RetryPolicySchema = z.object({
  owner: z.enum(['tool', 'middleware']).default('middleware'),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  delayMs: z.number().int().min(0).max(60_000).default(0),
  idempotent: z.boolean().default(false),
});
export type RetryPolicy = z.input<typeof RetryPolicySchema>;

export const ToolPolicySchema = z.object({
  kind: z.enum(['document-read', 'source-read', 'mutation', 'auxiliary']),
  retry: RetryPolicySchema.optional(),
});
export type ToolPolicy = z.input<typeof ToolPolicySchema>;

/** All methods are trusted-server operations, never tool calls or client endpoints. */
export interface GuardrailStore {
  getReceipt(key: string): Promise<ModerationReceipt | null>;
  /** Atomic insert-if-absent; returns the winning immutable receipt. */
  putReceiptIfAbsent(key: string, receipt: ModerationReceipt): Promise<ModerationReceipt>;
  recordSuccessfulRead(key: string, evidence: string): Promise<void>;
  hasSuccessfulRead(key: string, evidence: string): Promise<boolean>;
  /** Atomic unique claim per turn. Same identity replays only after complete settlement. */
  claimMutation(key: string, identity: MutationIdentity): Promise<ClaimResult>;
  /** Atomic pending -> settlement compare-and-set by claim token. Never release a claim. */
  settleMutation(key: string, token: string, settlement: MutationSettlement): Promise<void>;
}
