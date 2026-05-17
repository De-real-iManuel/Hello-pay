/**
 * Property-based tests for SapRegistrar in src/agent/SapRegistrar.ts
 *
 * **Property 8: Idempotent Registration** — calling `ensureRegistered()` N times
 * with the same keypair produces the same PDA address and submits at most 1
 * registration transaction.
 *
 * **Validates: Requirements 2.3**
 */

import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { SapRegistrar } from '../../src/agent/SapRegistrar.js';

// ---------------------------------------------------------------------------
// Stateful mock factory
// ---------------------------------------------------------------------------

function buildStatefulMockClient() {
  let registered = false;
  let registerCallCount = 0;

  const mockAccount = {
    bump: 255,
    version: 1,
    wallet: { toBase58: () => 'WalletPubkey' },
    name: 'ResearchBriefAgent',
    description: 'Test',
    agentId: null,
    agentUri: null,
    x402Endpoint: null,
    isActive: true,
    createdAt: { toNumber: () => 0 },
    updatedAt: { toNumber: () => 0 },
    reputationScore: 0,
    totalFeedbacks: 0,
    reputationSum: { toNumber: () => 0 },
    totalCallsServed: { toNumber: () => 0 },
    avgLatencyMs: 0,
    uptimePercent: 100,
    capabilities: [],
    pricing: [],
    protocols: [],
    activePlugins: [],
  };

  return {
    client: {
      agent: {
        fetchNullable: vi.fn(async () => (registered ? mockAccount : null)),
        register: vi.fn(async () => {
          registered = true;
          registerCallCount++;
        }),
        reactivate: vi.fn(async () => {}),
        fetch: vi.fn(async () => mockAccount),
        deriveAgent: vi.fn(() => [{ toBase58: () => 'AgentPDA_fixed_address' }, 255]),
      },
      indexing: {
        initCapabilityIndex: vi.fn(async () => {}),
        addToCapabilityIndex: vi.fn(async () => {}),
      },
      tools: {
        publishByName: vi.fn(async () => {}),
      },
    },
    getRegisterCallCount: () => registerCallCount,
  };
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig = {
  name: 'ResearchBriefAgent',
  description: 'Test agent',
  capabilities: [
    { id: 'acedata:search', protocolId: 'acedata', version: '1.0', description: 'Web search' },
    { id: 'acedata:llm', protocolId: 'acedata', version: '1.0', description: 'LLM' },
    { id: 'acedata:image', protocolId: 'acedata', version: '1.0', description: 'Image gen' },
    { id: 'data:oracle', protocolId: 'pyth', version: '1.0', description: 'Price oracle' },
  ],
  protocols: ['A2A', 'MCP', 'acedata'],
  x402Endpoint: 'https://agent.example.com',
};

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('SapRegistrar Properties', () => {
  describe('Property 8: Idempotent Registration', () => {
    it(
      '**Validates: Requirements 2.3** — calling ensureRegistered() N times submits at most 1 registration and always returns the same account',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 10 }),
            async (n: number) => {
              const { client, getRegisterCallCount } = buildStatefulMockClient();
              const registrar = new SapRegistrar(client);

              // Call ensureRegistered N times
              const results = [];
              for (let i = 0; i < n; i++) {
                const account = await registrar.ensureRegistered(testConfig);
                results.push(account);
              }

              // 1. register() was called exactly once regardless of N
              expect(getRegisterCallCount()).toBe(1);

              // 2. All N calls returned an account with isActive === true
              for (const account of results) {
                expect(account.isActive).toBe(true);
              }

              // 3. All N calls returned the same name
              const names = results.map((a) => a.name);
              expect(new Set(names).size).toBe(1);
              expect(names[0]).toBe('ResearchBriefAgent');
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      '**Validates: Requirements 2.3** — fetchProfile() always returns the same PDA address across N calls',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            fc.integer({ min: 1, max: 10 }),
            async (n: number) => {
              const { client } = buildStatefulMockClient();
              const registrar = new SapRegistrar(client);

              // Ensure registered first
              await registrar.ensureRegistered(testConfig);

              // Fetch profile N times and collect PDA addresses
              const pdaAddresses: string[] = [];
              for (let i = 0; i < n; i++) {
                const profile = await registrar.fetchProfile();
                pdaAddresses.push(profile.agentPda);
              }

              // All PDA addresses must be identical
              expect(new Set(pdaAddresses).size).toBe(1);
              expect(pdaAddresses[0]).toBe('AgentPDA_fixed_address');
            }
          ),
          { numRuns: 5 }
        );
      }
    );
  });
});
