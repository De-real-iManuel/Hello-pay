/**
 * Property-based tests for ToolDiscovery in src/agent/ToolDiscovery.ts
 *
 * **Property 25: Sentinel Discovery Validation** — for any list of agent
 * profiles, `ToolDiscovery` correctly identifies Sentinel by wallet address
 * and rejects profiles where `isActive === false` or `hasX402 === false`.
 *
 * **Validates: Requirements 3.2, 3.5**
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { ToolDiscovery } from '../../src/agent/ToolDiscovery.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_WALLET = 'Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock wallet object that mimics a Solana PublicKey. */
function makeWallet(address: string) {
  return { toBase58: () => address };
}

/** Build a discovered-agent entry (as returned by findAgentsByCapability). */
function makeDiscoveredAgent(walletAddress: string) {
  return {
    pda: makeWallet('AgentPDA_' + walletAddress.slice(0, 8)),
    identity: {
      wallet: makeWallet(walletAddress),
      name: 'TestAgent',
    },
    stats: null,
  };
}

/** Build a full AgentProfile (as returned by getAgentProfile). */
function makeAgentProfile(
  walletAddress: string,
  isActive: boolean,
  hasX402: boolean
) {
  return {
    pda: makeWallet('AgentPDA_' + walletAddress.slice(0, 8)),
    identity: {
      wallet: makeWallet(walletAddress),
      name: 'TestAgent',
      isActive,
      x402Endpoint: hasX402 ? 'https://agent.example.com' : null,
      capabilities: [],
      pricing: [],
      protocols: [],
    },
    stats: null,
    computed: {
      isActive,
      hasX402,
      totalCalls: '0',
      reputationScore: 0,
      capabilityCount: 1,
      pricingTierCount: 0,
      protocols: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a random non-Sentinel wallet address (44-char base58-like string).
 * We use a fixed prefix to ensure it never accidentally equals SENTINEL_WALLET.
 */
const nonSentinelWalletArb = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((s) => 'X' + s.slice(0, 43)); // always starts with 'X', Sentinel starts with 'C'

/** Generates a random agent profile entry (wallet, isActive, hasX402). */
const agentProfileArb = fc.record({
  wallet: nonSentinelWalletArb,
  isActive: fc.boolean(),
  hasX402: fc.boolean(),
});

/** Generates a list of 0–9 non-Sentinel agent profiles. */
const agentListArb = fc.array(agentProfileArb, { minLength: 0, maxLength: 9 });

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

/**
 * Builds a mock SAP client whose discovery methods are driven by the
 * provided list of discovered agents and a profile map.
 */
function buildMockClient(
  discoveredAgents: Array<ReturnType<typeof makeDiscoveredAgent>>,
  profileMap: Map<string, ReturnType<typeof makeAgentProfile>>
) {
  return {
    discovery: {
      findAgentsByCapability: vi.fn().mockResolvedValue(discoveredAgents),
      getAgentProfile: vi.fn().mockImplementation((wallet: unknown) => {
        const addr =
          typeof (wallet as { toBase58?: () => string }).toBase58 === 'function'
            ? (wallet as { toBase58: () => string }).toBase58()
            : String(wallet);
        return Promise.resolve(profileMap.get(addr) ?? null);
      }),
      isAgentActive: vi.fn().mockResolvedValue(false),
    },
  };
}

// ---------------------------------------------------------------------------
// Property 25: Sentinel Discovery Validation
// ---------------------------------------------------------------------------

describe('ToolDiscovery Properties', () => {
  describe('Property 25: Sentinel Discovery Validation', () => {
    it(
      '**Validates: Requirements 3.2, 3.5** — findSentinel() succeeds only when Sentinel wallet is present AND isActive === true AND hasX402 === true',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // Random list of non-Sentinel agents
            agentListArb,
            // Sentinel's own flags
            fc.boolean(), // sentinelIsActive
            fc.boolean(), // sentinelHasX402
            // Whether Sentinel appears in the discovery list at all
            fc.boolean(), // sentinelPresent
            async (
              otherAgents: Array<{ wallet: string; isActive: boolean; hasX402: boolean }>,
              sentinelIsActive: boolean,
              sentinelHasX402: boolean,
              sentinelPresent: boolean
            ) => {
              // Build the discovered-agent list
              const otherDiscovered = otherAgents.map((a) =>
                makeDiscoveredAgent(a.wallet)
              );

              const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
              const allDiscovered = sentinelPresent
                ? [...otherDiscovered, sentinelDiscovered]
                : otherDiscovered;

              // Build the profile map
              const profileMap = new Map<string, ReturnType<typeof makeAgentProfile>>();
              for (const a of otherAgents) {
                profileMap.set(a.wallet, makeAgentProfile(a.wallet, a.isActive, a.hasX402));
              }
              if (sentinelPresent) {
                profileMap.set(
                  SENTINEL_WALLET,
                  makeAgentProfile(SENTINEL_WALLET, sentinelIsActive, sentinelHasX402)
                );
              }

              const client = buildMockClient(allDiscovered, profileMap);
              const discovery = new ToolDiscovery(client);

              const shouldSucceed =
                sentinelPresent && sentinelIsActive && sentinelHasX402;

              if (shouldSucceed) {
                // Must return the Sentinel profile without throwing
                const profile = await discovery.findSentinel();
                expect(profile.computed.isActive).toBe(true);
                expect(profile.computed.hasX402).toBe(true);
              } else {
                // Must throw for any other combination
                await expect(discovery.findSentinel()).rejects.toThrow();
              }
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      '**Validates: Requirements 3.2** — findSentinel() throws when Sentinel is absent regardless of other agents',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            // At least one non-Sentinel agent present (non-empty list)
            fc.array(agentProfileArb, { minLength: 1, maxLength: 5 }),
            async (
              otherAgents: Array<{ wallet: string; isActive: boolean; hasX402: boolean }>
            ) => {
              const otherDiscovered = otherAgents.map((a) =>
                makeDiscoveredAgent(a.wallet)
              );
              const profileMap = new Map<string, ReturnType<typeof makeAgentProfile>>();
              for (const a of otherAgents) {
                profileMap.set(a.wallet, makeAgentProfile(a.wallet, a.isActive, a.hasX402));
              }

              const client = buildMockClient(otherDiscovered, profileMap);
              const discovery = new ToolDiscovery(client);

              // Sentinel is not in the list — must always throw
              await expect(discovery.findSentinel()).rejects.toThrow(SENTINEL_WALLET);
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      '**Validates: Requirements 3.5** — findSentinel() throws when Sentinel is present but isActive === false',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            agentListArb,
            fc.boolean(), // sentinelHasX402 (irrelevant — isActive is false)
            async (
              otherAgents: Array<{ wallet: string; isActive: boolean; hasX402: boolean }>,
              sentinelHasX402: boolean
            ) => {
              const otherDiscovered = otherAgents.map((a) =>
                makeDiscoveredAgent(a.wallet)
              );
              const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
              const allDiscovered = [...otherDiscovered, sentinelDiscovered];

              const profileMap = new Map<string, ReturnType<typeof makeAgentProfile>>();
              for (const a of otherAgents) {
                profileMap.set(a.wallet, makeAgentProfile(a.wallet, a.isActive, a.hasX402));
              }
              // Sentinel is inactive
              profileMap.set(
                SENTINEL_WALLET,
                makeAgentProfile(SENTINEL_WALLET, false, sentinelHasX402)
              );

              const client = buildMockClient(allDiscovered, profileMap);
              const discovery = new ToolDiscovery(client);

              await expect(discovery.findSentinel()).rejects.toThrow(/isActive === false/);
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      '**Validates: Requirements 3.5** — findSentinel() throws when Sentinel is present and active but hasX402 === false',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            agentListArb,
            async (
              otherAgents: Array<{ wallet: string; isActive: boolean; hasX402: boolean }>
            ) => {
              const otherDiscovered = otherAgents.map((a) =>
                makeDiscoveredAgent(a.wallet)
              );
              const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
              const allDiscovered = [...otherDiscovered, sentinelDiscovered];

              const profileMap = new Map<string, ReturnType<typeof makeAgentProfile>>();
              for (const a of otherAgents) {
                profileMap.set(a.wallet, makeAgentProfile(a.wallet, a.isActive, a.hasX402));
              }
              // Sentinel is active but has no x402 endpoint
              profileMap.set(
                SENTINEL_WALLET,
                makeAgentProfile(SENTINEL_WALLET, true, false)
              );

              const client = buildMockClient(allDiscovered, profileMap);
              const discovery = new ToolDiscovery(client);

              await expect(discovery.findSentinel()).rejects.toThrow(/hasX402 === false/);
            }
          ),
          { numRuns: 5 }
        );
      }
    );
  });
});
