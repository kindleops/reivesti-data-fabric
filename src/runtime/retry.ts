// Retry and rate limiting. Both take their sleep function as an argument so
// tests exercise the real policy without spending real seconds.
import type { Logger } from '../core/logging.ts';

export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export type RetryPolicy = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Only errors this returns true for are retried; everything else fails fast. */
  readonly retryable: (error: unknown) => boolean;
};

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  retryable: (e) => {
    // Transport faults are worth another attempt. Parse, schema, access and
    // immutability failures are not: retrying them just repeats the same answer.
    const kind = (e as { kind?: string } | null)?.kind;
    return kind === undefined || kind === 'TRANSPORT';
  },
};

export function backoffDelay(policy: RetryPolicy, attempt: number): number {
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: { policy?: RetryPolicy; sleep?: Sleep; logger?: Logger; label?: string } = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const sleep = options.sleep ?? realSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const canRetry = attempt < policy.maxAttempts && policy.retryable(error);
      options.logger?.warn('retry.attempt_failed', {
        label: options.label,
        attempt,
        maxAttempts: policy.maxAttempts,
        willRetry: canRetry,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!canRetry) throw error;
      await sleep(backoffDelay(policy, attempt));
    }
  }
  throw lastError;
}

export type RateLimiter = { acquire(): Promise<void> };

/** Simple minimum-interval limiter. Publishers ask for politeness, not bursts. */
export function createRateLimiter(
  minIntervalMs: number,
  deps: { sleep?: Sleep; now?: () => number } = {},
): RateLimiter {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? (() => Date.now());
  let nextAllowedAt = 0;

  return {
    async acquire() {
      if (minIntervalMs <= 0) return;
      const wait = nextAllowedAt - now();
      if (wait > 0) await sleep(wait);
      nextAllowedAt = Math.max(now(), nextAllowedAt) + minIntervalMs;
    },
  };
}

/** A limiter that never waits. Used by replay, which touches no network. */
export const noRateLimit: RateLimiter = { acquire: async () => {} };
