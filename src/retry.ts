import { setTimeout } from 'node:timers/promises';
import { RetryPolicySchema, type RetryPolicy } from './contracts.js';

export class RetryableToolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableToolError';
  }
}

/**
 * Retry only typed transient exceptions. ToolMessage errors are terminal outcomes.
 * A completed result is returned even if cancellation arrived during the operation;
 * the caller can persist that known outcome before propagating cancellation.
 * @example await runWithRetryBoundary(read, { policy: { maxAttempts: 2 } });
 */
export async function runWithRetryBoundary<T>(
  operation: () => Promise<T>,
  options: { policy?: RetryPolicy; mutation?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const policy = RetryPolicySchema.parse(options.policy ?? {});
  const attempts =
    policy.owner === 'tool' || (options.mutation && !policy.idempotent) ? 1 : policy.maxAttempts;
  for (let attempt = 1; ; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!(error instanceof RetryableToolError) || attempt >= attempts) throw error;
      await setTimeout(policy.delayMs, undefined, { signal: options.signal });
    }
  }
}
