/**
 * Property-based tests for retry utility in src/utils/retry.ts
 * Validates retry behavior, attempt bounds, and error handling.
 *
 * All properties use fc.asyncProperty() + await fc.assert() because the
 * predicates call async functions (withRetry returns a Promise).
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { withRetry, type RetryOptions } from '../../src/utils/retry.js';

// Use tiny delays so property tests finish quickly.
const FAST_OPTS = { numRuns: 5 };

describe('Retry Utility Properties', () => {
  describe('Property 18: Transient Error Retry Bound', () => {
    it('**Validates: Requirements 12.1** — for any stage that fails with a transient error, total attempts never exceed maxAttempts', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            baseDelayMs: fc.constant(1),   // 1 ms — fast
            maxDelayMs: fc.constant(5),    // 5 ms cap
          }),
          fc.string({ minLength: 1 }).map(msg => new Error(msg)),
          async (retryOptions: RetryOptions, error: Error) => {
            let attemptCount = 0;

            const alwaysFailsFn = vi.fn(async () => {
              attemptCount++;
              throw error;
            });

            await expect(withRetry(alwaysFailsFn, retryOptions)).rejects.toThrow();

            // Must be called exactly maxAttempts times — never more
            expect(attemptCount).toBe(retryOptions.maxAttempts);
            expect(alwaysFailsFn).toHaveBeenCalledTimes(retryOptions.maxAttempts);
          }
        ),
        FAST_OPTS
      );
    });

    it('should succeed on first attempt when function succeeds', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            baseDelayMs: fc.constant(1),
            maxDelayMs: fc.constant(5),
          }),
          fc.anything(),
          async (retryOptions: RetryOptions, successValue: unknown) => {
            let attemptCount = 0;

            const succeedsFn = vi.fn(async () => {
              attemptCount++;
              return successValue;
            });

            const result = await withRetry(succeedsFn, retryOptions);

            expect(attemptCount).toBe(1);
            expect(succeedsFn).toHaveBeenCalledTimes(1);
            expect(result).toBe(successValue);
          }
        ),
        FAST_OPTS
      );
    });

    it('should succeed on retry when function eventually succeeds', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 2, max: 5 }),
            baseDelayMs: fc.constant(1),
            maxDelayMs: fc.constant(5),
          }),
          fc.integer({ min: 1, max: 4 }),
          fc.anything(),
          async (retryOptions: RetryOptions, failuresBeforeSuccess: number, successValue: unknown) => {
            // Only test cases where we have enough attempts to succeed
            fc.pre(failuresBeforeSuccess < retryOptions.maxAttempts);

            let attemptCount = 0;

            const eventuallySucceedsFn = vi.fn(async () => {
              attemptCount++;
              if (attemptCount <= failuresBeforeSuccess) {
                throw new Error(`Attempt ${attemptCount} failed`);
              }
              return successValue;
            });

            const result = await withRetry(eventuallySucceedsFn, retryOptions);

            expect(attemptCount).toBe(failuresBeforeSuccess + 1);
            expect(eventuallySucceedsFn).toHaveBeenCalledTimes(failuresBeforeSuccess + 1);
            expect(result).toBe(successValue);
          }
        ),
        FAST_OPTS
      );
    });

    it('should rethrow the last error when all attempts are exhausted', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 4 }),
            baseDelayMs: fc.constant(1),
            maxDelayMs: fc.constant(5),
          }),
          fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 5 }),
          async (retryOptions: RetryOptions, errorMessages: string[]) => {
            let attemptCount = 0;

            const alwaysFailsFn = vi.fn(async () => {
              const errorIndex = Math.min(attemptCount, errorMessages.length - 1);
              attemptCount++;
              throw new Error(errorMessages[errorIndex]);
            });

            let thrownError: Error | undefined;
            try {
              await withRetry(alwaysFailsFn, retryOptions);
            } catch (error) {
              thrownError = error as Error;
            }

            expect(thrownError).toBeInstanceOf(Error);

            // The last error thrown is from the final attempt
            const expectedErrorIndex = Math.min(retryOptions.maxAttempts - 1, errorMessages.length - 1);
            expect(thrownError?.message).toBe(errorMessages[expectedErrorIndex]);

            expect(attemptCount).toBe(retryOptions.maxAttempts);
          }
        ),
        FAST_OPTS
      );
    });

    it('should respect maxAttempts of 1 (no retries)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.constant(1),
            baseDelayMs: fc.constant(1),
            maxDelayMs: fc.constant(5),
          }),
          fc.string({ minLength: 1 }),
          async (retryOptions: RetryOptions, errorMessage: string) => {
            let attemptCount = 0;

            const failsOnceFn = vi.fn(async () => {
              attemptCount++;
              throw new Error(errorMessage);
            });

            await expect(withRetry(failsOnceFn, retryOptions)).rejects.toThrow(errorMessage);

            expect(attemptCount).toBe(1);
            expect(failsOnceFn).toHaveBeenCalledTimes(1);
          }
        ),
        FAST_OPTS
      );
    });
  });

  describe('Retry delay behavior properties', () => {
    it('should apply delays between attempts but not after the final attempt', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 2, max: 3 }),
            baseDelayMs: fc.constant(10),
            maxDelayMs: fc.constant(50),
          }),
          async (retryOptions: RetryOptions) => {
            const startTime = Date.now();
            let attemptCount = 0;

            const alwaysFailsFn = vi.fn(async () => {
              attemptCount++;
              throw new Error(`Attempt ${attemptCount} failed`);
            });

            await expect(withRetry(alwaysFailsFn, retryOptions)).rejects.toThrow();

            const totalTime = Date.now() - startTime;

            expect(attemptCount).toBe(retryOptions.maxAttempts);

            // At least (maxAttempts - 1) delays of baseDelayMs * 0.8 (min jitter)
            // Use 50% tolerance for CI timing variance
            const minExpectedTime = (retryOptions.maxAttempts - 1) * retryOptions.baseDelayMs * 0.8;
            expect(totalTime).toBeGreaterThanOrEqual(minExpectedTime * 0.5);
          }
        ),
        FAST_OPTS
      );
    });
  });

  describe('Edge cases and invariants', () => {
    it('should handle zero maxAttempts gracefully', async () => {
      const retryOptions: RetryOptions = {
        maxAttempts: 0,
        baseDelayMs: 1,
        maxDelayMs: 5,
      };

      let attemptCount = 0;
      const neverCalledFn = vi.fn(async () => {
        attemptCount++;
        return 'success';
      });

      try {
        await withRetry(neverCalledFn, retryOptions);
      } catch {
        // May throw — behaviour with 0 attempts is undefined but must not exceed 0 calls
      }

      expect(attemptCount).toBeLessThanOrEqual(retryOptions.maxAttempts);
    });

    it('should preserve error types and properties', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 3 }),
            baseDelayMs: fc.constant(1),
            maxDelayMs: fc.constant(5),
          }),
          fc.string({ minLength: 1 }),
          fc.integer({ min: 100, max: 599 }),
          async (retryOptions: RetryOptions, message: string, statusCode: number) => {
            class CustomError extends Error {
              constructor(message: string, public statusCode: number) {
                super(message);
                this.name = 'CustomError';
              }
            }

            const customError = new CustomError(message, statusCode);

            const throwsCustomErrorFn = vi.fn(async () => {
              throw customError;
            });

            let caughtError: CustomError | undefined;
            try {
              await withRetry(throwsCustomErrorFn, retryOptions);
            } catch (error) {
              caughtError = error as CustomError;
            }

            // Must preserve the exact error instance and its properties
            expect(caughtError).toBe(customError);
            expect(caughtError?.name).toBe('CustomError');
            expect(caughtError?.statusCode).toBe(statusCode);
            expect(caughtError?.message).toBe(message);
          }
        ),
        FAST_OPTS
      );
    });
  });
});
