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
export declare function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map