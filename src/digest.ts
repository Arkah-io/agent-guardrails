import { createHash } from 'node:crypto';
import type { TurnScope } from './contracts.js';

/** Hash JSON without depending on object key order. Reject lossy non-JSON values. */
export function digest(value: unknown): string {
  const ancestors = new WeakSet<object>();
  function canonical(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      return JSON.stringify(item);
    }
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (item && typeof item === 'object') {
      const array = Array.isArray(item);
      if (ancestors.has(item)) throw new TypeError('Guardrail inputs must be acyclic JSON values');
      if (array || Object.getPrototypeOf(item) === Object.prototype) {
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Object.keys(descriptors).filter((key) => !array || key !== 'length');
        if (
          Object.getOwnPropertySymbols(item).length > 0 ||
          keys.some((key) => !descriptors[key]?.enumerable || !('value' in descriptors[key]!)) ||
          (array &&
            (keys.length !== item.length || keys.some((key, index) => key !== String(index))))
        ) {
          throw new TypeError('Guardrail inputs must be plain, dense JSON values');
        }
        ancestors.add(item);
        try {
          if (array) return `[${keys.map((key) => canonical(descriptors[key]!.value)).join(',')}]`;
          return `{${keys
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key]!.value)}`)
            .join(',')}}`;
        } finally {
          ancestors.delete(item);
        }
      }
    }
    throw new TypeError('Guardrail inputs must be finite JSON values');
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Policy changes cannot create another mutation slot for the same logical turn. */
export function turnKey(turn: TurnScope): string {
  return digest({ scopeId: turn.scopeId, turnId: turn.turnId });
}
