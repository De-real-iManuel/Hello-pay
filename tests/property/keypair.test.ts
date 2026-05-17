/**
 * Property-based tests for keypair loading security in src/utils/keypair.ts
 *
 * Validates that raw keypair bytes are never exposed in error messages,
 * regardless of the input provided.
 *
 * Requirements: 14.6
 */

import { describe, it, afterEach } from 'vitest';
import { expect } from 'vitest';
import * as fc from 'fast-check';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadKeypair } from '../../src/utils/keypair.js';
import { InvalidKeypairError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write arbitrary content to a temp file and return its path. */
function writeTempFile(filename: string, content: string): string {
  const dir = join(tmpdir(), 'keypair-pbt');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Returns true if the error message contains any representation of the raw
 * byte array that could leak key material:
 *   - A JSON-style numeric array substring, e.g. "[1,2,3,...]"
 *   - A comma-separated run of numbers long enough to represent key bytes
 *   - A hex string of 32+ bytes (64+ hex chars)
 */
function messageContainsRawBytes(message: string, bytes: number[]): boolean {
  // Check for the exact JSON serialisation of the array
  const jsonRepr = JSON.stringify(bytes);
  if (message.includes(jsonRepr)) return true;

  // Check for any contiguous run of ≥8 comma-separated numbers that appear
  // in the message — a heuristic for a partial key dump
  const numericRunPattern = /(\d+,\s*){7,}\d+/;
  if (numericRunPattern.test(message)) return true;

  // Check for a long hex string (≥64 chars) that could encode key material
  if (/[0-9a-fA-F]{64,}/.test(message)) return true;

  // Check whether any 8-byte contiguous slice of the array appears as a
  // comma-separated substring in the message (catches partial leaks)
  for (let i = 0; i <= bytes.length - 8; i++) {
    const slice = bytes.slice(i, i + 8).join(',');
    if (message.includes(slice)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Property 23: Keypair Not Exposed in Logs
// ---------------------------------------------------------------------------

describe('Keypair Security Properties', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  describe('Property 23: Keypair Not Exposed in Logs', () => {
    it('**Validates: Requirements 14.6** — for any wrong-length byte array written to a file, the InvalidKeypairError message does not contain the raw bytes', () => {
      fc.assert(
        fc.property(
          // Generate byte arrays of arbitrary length, excluding exactly 64 (which may succeed)
          fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 200 }).filter(
            (arr) => arr.length !== 64
          ),
          fc.nat(), // unique file index to avoid collisions
          (bytes, idx) => {
            const filePath = writeTempFile(`wrong-length-${idx}.json`, JSON.stringify(bytes));
            tempFiles.push(filePath);

            let thrownError: unknown;
            try {
              loadKeypair(filePath);
            } catch (err) {
              thrownError = err;
            }

            // Must throw InvalidKeypairError
            expect(thrownError).toBeInstanceOf(InvalidKeypairError);

            const errorMessage = (thrownError as InvalidKeypairError).message;

            // The error message must NOT contain the raw byte array
            expect(messageContainsRawBytes(errorMessage, bytes)).toBe(false);
          }
        ),
        { numRuns: 5 }
      );
    });

    it('**Validates: Requirements 14.6** — for any 64-element array containing non-numeric or out-of-range values, the InvalidKeypairError message does not contain the raw bytes', () => {
      fc.assert(
        fc.property(
          // Generate a 64-element array where at least one element is invalid
          fc.tuple(
            fc.integer({ min: 0, max: 63 }), // index of the bad element
            fc.oneof(
              fc.string({ minLength: 1, maxLength: 10 }), // string instead of number
              fc.double({ min: 0.1, max: 254.9 }).filter(n => !Number.isInteger(n)), // float
              fc.integer({ min: 256, max: 1000 }), // out-of-range high
              fc.integer({ min: -1000, max: -1 }),  // out-of-range low
            ),
          ).chain(([badIdx, badValue]) => {
            // Build a 64-element array with valid bytes everywhere except badIdx
            const arr: unknown[] = Array.from({ length: 64 }, (_, i) =>
              i === badIdx ? badValue : Math.floor(Math.random() * 256)
            );
            return fc.constant({ arr, badIdx });
          }),
          fc.nat(),
          ({ arr }, idx) => {
            const filePath = writeTempFile(`invalid-bytes-${idx}.json`, JSON.stringify(arr));
            tempFiles.push(filePath);

            let thrownError: unknown;
            try {
              loadKeypair(filePath);
            } catch (err) {
              thrownError = err;
            }

            // Must throw InvalidKeypairError
            expect(thrownError).toBeInstanceOf(InvalidKeypairError);

            const errorMessage = (thrownError as InvalidKeypairError).message;

            // Filter to only numeric elements for the leak check
            const numericBytes = (arr as unknown[])
              .filter((v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255);

            // The error message must NOT contain the raw numeric bytes
            if (numericBytes.length >= 8) {
              expect(messageContainsRawBytes(errorMessage, numericBytes)).toBe(false);
            }
          }
        ),
        { numRuns: 5 }
      );
    });

    it('**Validates: Requirements 14.6** — for a missing file path, the InvalidKeypairError message does not contain any byte sequences', () => {
      fc.assert(
        fc.property(
          // Generate arbitrary path suffixes that won't exist on disk
          fc.string({ minLength: 1, maxLength: 50 }).map(s => s.replace(/[<>:"|?*\\/]/g, '_')),
          (suffix) => {
            const nonExistentPath = join(tmpdir(), 'keypair-pbt', `missing-${suffix}-${Date.now()}.json`);

            let thrownError: unknown;
            try {
              loadKeypair(nonExistentPath);
            } catch (err) {
              thrownError = err;
            }

            // Must throw InvalidKeypairError
            expect(thrownError).toBeInstanceOf(InvalidKeypairError);

            const errorMessage = (thrownError as InvalidKeypairError).message;

            // No raw byte sequences should appear in the message
            expect(/(\d+,\s*){7,}\d+/.test(errorMessage)).toBe(false);
            expect(/[0-9a-fA-F]{64,}/.test(errorMessage)).toBe(false);
          }
        ),
        { numRuns: 5 }
      );
    });

    it('**Validates: Requirements 14.6** — for any valid 64-byte array that is cryptographically invalid, the InvalidKeypairError message does not contain the raw bytes', () => {
      fc.assert(
        fc.property(
          // Generate exactly 64 bytes — these may or may not form a valid Solana keypair.
          // We use arrays that are unlikely to be valid ed25519 keys (all zeros, all same value, etc.)
          fc.oneof(
            fc.constant(Array(64).fill(0)),                          // all zeros — invalid key
            fc.constant(Array(64).fill(255)),                        // all 0xFF — invalid key
            fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 64, maxLength: 64 }),
          ),
          fc.nat(),
          (bytes, idx) => {
            const filePath = writeTempFile(`maybe-invalid-64-${idx}.json`, JSON.stringify(bytes));
            tempFiles.push(filePath);

            let thrownError: unknown;
            try {
              loadKeypair(filePath);
              // If it succeeds (valid keypair), that's fine — no error to check
              return;
            } catch (err) {
              thrownError = err;
            }

            // If an error was thrown it must be InvalidKeypairError
            expect(thrownError).toBeInstanceOf(InvalidKeypairError);

            const errorMessage = (thrownError as InvalidKeypairError).message;

            // The error message must NOT contain the raw byte array
            expect(messageContainsRawBytes(errorMessage, bytes as number[])).toBe(false);
          }
        ),
        { numRuns: 5 }
      );
    });
  });
});
