/**
 * Unit tests for keypair loading utility.
 *
 * Tests the loadKeypair() function with various file/data scenarios
 * to ensure proper validation and error handling without exposing key material.
 *
 * Requirements: 1.4, 1.5, 14.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Keypair } from '@solana/web3.js';
import { loadKeypair } from '../../src/utils/keypair.js';
import { InvalidKeypairError } from '../../src/utils/errors.js';

/** Helper: write a JSON file to a temp path and return the path. */
function writeTempJson(filename: string, content: unknown): string {
  const dir = join(tmpdir(), 'keypair-tests');
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(content), 'utf-8');
  return filePath;
}

/** Helper: generate a valid 64-byte secret key array (real Solana keypair). */
function validSecretKeyArray(): number[] {
  const kp = Keypair.generate();
  return Array.from(kp.secretKey);
}

describe('loadKeypair', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    // Clean up any temp files created during tests
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  // ── Test 1: valid 64-byte array → returns Keypair ──────────────────────────

  it('should return a Keypair when given a valid 64-byte array', () => {
    const secretKeyArray = validSecretKeyArray();
    const filePath = writeTempJson('valid-keypair.json', secretKeyArray);
    tempFiles.push(filePath);

    const keypair = loadKeypair(filePath);

    expect(keypair).toBeInstanceOf(Keypair);
    // The public key should be a non-empty base58 string
    expect(keypair.publicKey.toBase58()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    // The secret key should be exactly 64 bytes
    expect(keypair.secretKey).toHaveLength(64);
  });

  it('should reconstruct the same public key from the same secret key bytes', () => {
    const original = Keypair.generate();
    const secretKeyArray = Array.from(original.secretKey);
    const filePath = writeTempJson('roundtrip-keypair.json', secretKeyArray);
    tempFiles.push(filePath);

    const loaded = loadKeypair(filePath);

    expect(loaded.publicKey.toBase58()).toBe(original.publicKey.toBase58());
  });

  // ── Test 2: missing file → throws InvalidKeypairError ──────────────────────

  it('should throw InvalidKeypairError when the file does not exist', () => {
    const missingPath = join(tmpdir(), 'keypair-tests', 'does-not-exist.json');

    expect(() => loadKeypair(missingPath)).toThrow(InvalidKeypairError);
  });

  it('should include the file path in the error message when file is missing', () => {
    const missingPath = join(tmpdir(), 'keypair-tests', 'does-not-exist.json');

    try {
      loadKeypair(missingPath);
      expect.fail('Should have thrown InvalidKeypairError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeypairError);
      expect((error as InvalidKeypairError).message).toContain(missingPath);
      expect((error as InvalidKeypairError).code).toBe('INVALID_KEYPAIR');
    }
  });

  // ── Test 3: wrong-length array → throws InvalidKeypairError ────────────────

  it('should throw InvalidKeypairError when the array has fewer than 64 elements', () => {
    const shortArray = Array.from({ length: 32 }, (_, i) => i);
    const filePath = writeTempJson('short-keypair.json', shortArray);
    tempFiles.push(filePath);

    expect(() => loadKeypair(filePath)).toThrow(InvalidKeypairError);
  });

  it('should throw InvalidKeypairError when the array has more than 64 elements', () => {
    const longArray = Array.from({ length: 128 }, (_, i) => i % 256);
    const filePath = writeTempJson('long-keypair.json', longArray);
    tempFiles.push(filePath);

    expect(() => loadKeypair(filePath)).toThrow(InvalidKeypairError);
  });

  it('should throw InvalidKeypairError when the array is empty', () => {
    const filePath = writeTempJson('empty-array-keypair.json', []);
    tempFiles.push(filePath);

    expect(() => loadKeypair(filePath)).toThrow(InvalidKeypairError);
  });

  it('should include the element count in the error message for wrong-length arrays', () => {
    const shortArray = Array.from({ length: 32 }, (_, i) => i);
    const filePath = writeTempJson('short-keypair-msg.json', shortArray);
    tempFiles.push(filePath);

    try {
      loadKeypair(filePath);
      expect.fail('Should have thrown InvalidKeypairError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeypairError);
      expect((error as InvalidKeypairError).message).toContain('32');
      expect((error as InvalidKeypairError).code).toBe('INVALID_KEYPAIR');
    }
  });

  // ── Test 4: error message does not contain raw key bytes ───────────────────

  it('should not expose raw key bytes in the error message for a missing file', () => {
    const missingPath = join(tmpdir(), 'keypair-tests', 'no-key-bytes.json');

    try {
      loadKeypair(missingPath);
      expect.fail('Should have thrown InvalidKeypairError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeypairError);
      const msg = (error as InvalidKeypairError).message;
      // Must not contain a JSON array of numbers (raw key bytes)
      expect(msg).not.toMatch(/\[[\d,\s]{10,}\]/);
      // Must not contain a long hex string that could represent key material
      expect(msg).not.toMatch(/[0-9a-fA-F]{64,}/);
    }
  });

  it('should not expose raw key bytes in the error message for a wrong-length array', () => {
    const shortArray = Array.from({ length: 32 }, (_, i) => i);
    const filePath = writeTempJson('no-key-bytes-short.json', shortArray);
    tempFiles.push(filePath);

    try {
      loadKeypair(filePath);
      expect.fail('Should have thrown InvalidKeypairError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeypairError);
      const msg = (error as InvalidKeypairError).message;
      expect(msg).not.toMatch(/\[[\d,\s]{10,}\]/);
      expect(msg).not.toMatch(/[0-9a-fA-F]{64,}/);
    }
  });

  it('should not expose raw key bytes in the error message for invalid JSON', () => {
    const dir = join(tmpdir(), 'keypair-tests');
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'invalid-json.json');
    writeFileSync(filePath, 'not valid json', 'utf-8');
    tempFiles.push(filePath);

    try {
      loadKeypair(filePath);
      expect.fail('Should have thrown InvalidKeypairError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidKeypairError);
      const msg = (error as InvalidKeypairError).message;
      expect(msg).not.toMatch(/\[[\d,\s]{10,}\]/);
      expect(msg).not.toMatch(/[0-9a-fA-F]{64,}/);
    }
  });

  // ── Additional edge cases ───────────────────────────────────────────────────

  it('should throw InvalidKeypairError when file contains a non-array JSON value', () => {
    const filePath = writeTempJson('object-keypair.json', { key: 'value' });
    tempFiles.push(filePath);

    expect(() => loadKeypair(filePath)).toThrow(InvalidKeypairError);
  });

  it('should throw InvalidKeypairError when array contains non-number elements', () => {
    const invalidArray = Array.from({ length: 64 }, (_, i) => (i === 0 ? 'not-a-number' : i));
    const filePath = writeTempJson('non-number-keypair.json', invalidArray);
    tempFiles.push(filePath);

    expect(() => loadKeypair(filePath)).toThrow(InvalidKeypairError);
  });

  it('should have error code INVALID_KEYPAIR for all error cases', () => {
    const missingPath = join(tmpdir(), 'keypair-tests', 'code-check.json');

    try {
      loadKeypair(missingPath);
    } catch (error) {
      expect((error as InvalidKeypairError).code).toBe('INVALID_KEYPAIR');
    }
  });
});
