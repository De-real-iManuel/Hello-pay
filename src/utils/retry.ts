/**
 * Retry utility with exponential backoff and jitter.
 * Used by pipeline stages to handle transient network failures (Requirement 12.1).
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * Executes `fn` up to `opts.maxAttempts` times, applying exponential backoff
 * with ±20% jitter between attempts. Rethrows the last error once all attempts
 * are exhausted.
 *
 * Delay formula: `Math.min(baseDelayMs * 2^(attempt-1), maxDelayMs) * jitter`
 * where jitter is a random factor in [0.8, 1.2].
 *
 * @example
 * // maxAttempts: 3 → calls fn up to 3 times, delays after attempt 1 and 2
 * // maxAttempts: 1 → calls fn exactly once, throws immediately on failure
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = opts;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // No delay after the final attempt — just rethrow below.
      if (attempt < maxAttempts) {
        // Exponential backoff: baseDelayMs * 2^(attempt-1), capped at maxDelayMs.
        const baseDelay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs,
        );

        // Apply ±20% jitter: multiply by a random factor in [0.8, 1.2].
        const jitter = 0.8 + Math.random() * 0.4;
        const delay = Math.round(baseDelay * jitter);

        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}
