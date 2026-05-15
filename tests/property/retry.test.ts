/**
 * Property-based tests for retry utility in src/utils/retry.ts
 * Validates retry behavior, attempt bounds, and error handling.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { withRetry, type RetryOptions } from '../../src/utils/retry.js';

describe('Retry Utility Properties', () => {
  describe('Property 18: Transient Error Retry Bound', () => {
    it('**Validates: Requirements 12.1** — for any stage that fails with a transient error, total attempts never exceed maxAttempts', () => {
      fc.assert(
        fc.property(
          // Generate valid retry options
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 10 }),
            baseDelayMs: fc.integer({ min: 1, max: 1000 }),
            maxDelayMs: fc.integer({ min: 100, max: 5000 }),
          }),
          // Generate error to be thrown consistently
          fc.string({ minLength: 1 }).map(msg => new Error(msg)),
          async (retryOptions: RetryOptions, error: Error) => {
            let attemptCount = 0;
            
            // Create a function that always fails and counts attempts
            const alwaysFailsFn = vi.fn(async () => {
              attemptCount++;
              throw error;
            });

            // The retry function should throw after maxAttempts
            await expect(withRetry(alwaysFailsFn, retryOptions)).rejects.toThrow();
            
            // Verify that the function was called exactly maxAttempts times
            expect(attemptCount).toBe(retryOptions.maxAttempts);
            expect(alwaysFailsFn).toHaveBeenCalledTimes(retryOptions.maxAttempts);
            
            // Verify that attempts never exceed maxAttempts
            expect(attemptCount).toBeLessThanOrEqual(retryOptions.maxAttempts);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should succeed on first attempt when function succeeds', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 10 }),
            baseDelayMs: fc.integer({ min: 1, max: 1000 }),
            maxDelayMs: fc.integer({ min: 100, max: 5000 }),
          }),
          fc.anything(),
          async (retryOptions: RetryOptions, successValue: any) => {
            let attemptCount = 0;
            
            const succeedsFn = vi.fn(async () => {
              attemptCount++;
              return successValue;
            });

            const result = await withRetry(succeedsFn, retryOptions);
            
            // Should succeed on first attempt
            expect(attemptCount).toBe(1);
            expect(succeedsFn).toHaveBeenCalledTimes(1);
            expect(result).toBe(successValue);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('should succeed on retry when function eventually succeeds', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.integer({ min: 2, max: 10 }),
            baseDelayMs: fc.integer({ min: 1, max: 100 }), // Smaller delays for faster tests
            maxDelayMs: fc.integer({ min: 100, max: 500 }),
          }),
          fc.integer({ min: 1, max: 5 }), // Number of failures before success
          fc.anything(), // Success value
          async (retryOptions: RetryOptions, failuresBeforeSuccess: number, successValue: any) => {
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
            
            // Should succeed after failuresBeforeSuccess + 1 attempts
            expect(attemptCount).toBe(failuresBeforeSuccess + 1);
            expect(eventuallySucceedsFn).toHaveBeenCalledTimes(failuresBeforeSuccess + 1);
            expect(result).toBe(successValue);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('should rethrow the last error when all attempts are exhausted', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 5 }),
            baseDelayMs: fc.integer({ min: 1, max: 100 }),
            maxDelayMs: fc.integer({ min: 100, max: 500 }),
          }),
          fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
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
            
            // Should have thrown an error
            expect(thrownError).toBeInstanceOf(Error);
            
            // Should be the last error (from the final attempt)
            const expectedErrorIndex = Math.min(retryOptions.maxAttempts - 1, errorMessages.length - 1);
            expect(thrownError?.message).toBe(errorMessages[expectedErrorIndex]);
            
            // Should have made exactly maxAttempts attempts
            expect(attemptCount).toBe(retryOptions.maxAttempts);
          }
        ),
        { numRuns: 50 }
      );
    });

    it('should respect maxAttempts of 1 (no retries)', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.constant(1),
            baseDelayMs: fc.integer({ min: 1, max: 1000 }),
            maxDelayMs: fc.integer({ min: 100, max: 5000 }),
          }),
          fc.string({ minLength: 1 }),
          async (retryOptions: RetryOptions, errorMessage: string) => {
            let attemptCount = 0;
            
            const failsOnceFn = vi.fn(async () => {
              attemptCount++;
              throw new Error(errorMessage);
            });

            await expect(withRetry(failsOnceFn, retryOptions)).rejects.toThrow(errorMessage);
            
            // Should have made exactly 1 attempt (no retries)
            expect(attemptCount).toBe(1);
            expect(failsOnceFn).toHaveBeenCalledTimes(1);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe('Retry delay behavior properties', () => {
    it('should apply delays between attempts but not after the final attempt', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.integer({ min: 2, max: 4 }), // At least 2 attempts to test delays
            baseDelayMs: fc.integer({ min: 10, max: 50 }), // Small delays for fast tests
            maxDelayMs: fc.integer({ min: 100, max: 200 }),
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
            
            // Should have made maxAttempts attempts
            expect(attemptCount).toBe(retryOptions.maxAttempts);
            
            // Should have taken some time due to delays (but not too much due to jitter)
            // We expect at least (maxAttempts - 1) delays, each at least baseDelayMs * 0.8 (min jitter)
            const minExpectedTime = (retryOptions.maxAttempts - 1) * retryOptions.baseDelayMs * 0.8;
            expect(totalTime).toBeGreaterThanOrEqual(minExpectedTime * 0.5); // Allow some tolerance for test timing
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  describe('Edge cases and invariants', () => {
    it('should handle zero maxAttempts gracefully', async () => {
      const retryOptions: RetryOptions = {
        maxAttempts: 0,
        baseDelayMs: 100,
        maxDelayMs: 1000,
      };
      
      let attemptCount = 0;
      const neverCalledFn = vi.fn(async () => {
        attemptCount++;
        return 'success';
      });

      // With maxAttempts = 0, the function should not be called at all
      // The behavior is undefined in this edge case, but we document it
      try {
        await withRetry(neverCalledFn, retryOptions);
      } catch {
        // May throw due to no attempts made
      }
      
      // The function should not have been called more than maxAttempts (0)
      expect(attemptCount).toBeLessThanOrEqual(retryOptions.maxAttempts);
    });

    it('should preserve error types and properties', () => {
      fc.assert(
        fc.property(
          fc.record({
            maxAttempts: fc.integer({ min: 1, max: 3 }),
            baseDelayMs: fc.integer({ min: 1, max: 50 }),
            maxDelayMs: fc.integer({ min: 100, max: 200 }),
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
            
            // Should preserve the exact error instance and its properties
            expect(caughtError).toBe(customError);
            expect(caughtError?.name).toBe('CustomError');
            expect(caughtError?.statusCode).toBe(statusCode);
            expect(caughtError?.message).toBe(message);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});