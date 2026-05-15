/**
 * Property-based tests for configuration loading in src/config.ts
 * Validates that ConfigurationError lists ALL missing required environment variables.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { ConfigurationError } from '../../src/utils/errors.js';

// The two required env vars for loadConfig()
const REQUIRED_ENV_VARS = ['SOLANA_RPC_URL', 'WALLET_KEYPAIR_PATH'] as const;

describe('Configuration Loading Properties', () => {
  describe('Property 22: Configuration Error Lists All Missing Variables', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
      // Save current values of required env vars before each test
      savedEnv = {};
      for (const key of REQUIRED_ENV_VARS) {
        savedEnv[key] = process.env[key];
      }
    });

    afterEach(() => {
      // Restore env vars after each test
      for (const key of REQUIRED_ENV_VARS) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    });

    it('**Validates: Requirements 14.2** — for any non-empty subset of missing required env vars, loadConfig() throws ConfigurationError whose message contains every missing variable name', async () => {
      // We need to dynamically import loadConfig so that each call re-evaluates process.env.
      // The module is cached after first import, but loadConfig() reads process.env at call time.
      const { loadConfig } = await import('../../src/config.js');

      fc.assert(
        fc.property(
          // Generate all non-empty subsets of the required env var names
          fc.shuffledSubarray(REQUIRED_ENV_VARS as unknown as string[], { minLength: 1 }),
          (missingVars: string[]) => {
            // Set all required vars to valid values first
            process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
            process.env.WALLET_KEYPAIR_PATH = '/path/to/keypair.json';

            // Then unset the ones that should be missing
            for (const varName of missingVars) {
              delete process.env[varName];
            }

            let thrownError: unknown;
            try {
              loadConfig();
            } catch (err) {
              thrownError = err;
            }

            // (a) A ConfigurationError must be thrown
            expect(thrownError).toBeInstanceOf(ConfigurationError);

            const configError = thrownError as ConfigurationError;

            // (b) The error message must contain EVERY missing variable name
            for (const varName of missingVars) {
              expect(configError.message).toContain(varName);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    it('should not throw when all required env vars are present', async () => {
      const { loadConfig } = await import('../../src/config.js');

      process.env.SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com';
      process.env.WALLET_KEYPAIR_PATH = '/path/to/keypair.json';

      expect(() => loadConfig()).not.toThrow();
    });
  });
});
