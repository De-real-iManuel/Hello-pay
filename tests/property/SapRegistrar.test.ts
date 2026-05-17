/**
 * Property-based tests for SapRegistrar in src/agent/SapRegistrar.ts
 *
 * **Property 6: SAP Registration Precondition** — for any pipeline run, the
 * agent's `AgentAccount_PDA` has `isActive === true` before any API calls or
 * tool discovery steps execute.
 *
 * **Validates: Requirements 2.5, 2.1**
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
import { RegistrationError } from '../../src/utils/errors.js';

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

// ---------------------------------------------------------------------------
// Property 6: SAP Registration Precondition
// ---------------------------------------------------------------------------

/**
 * Builds a mock SAP client where fetchNullable returns a controlled account.
 *
 * @param initialAccount - The account returned by fetchNullable on the first call.
 *   Pass `null` to simulate a brand-new agent (no existing PDA).
 *   Pass an object with `isActive: true` to simulate an already-active agent.
 *   Pass an object with `isActive: false` to simulate an inactive agent.
 * @param postRegisterIsActive - What `isActive` the account has after register/reactivate.
 */
function buildPreconditionMockClient(
  initialAccount: { isActive: boolean; name: string } | null,
  postRegisterIsActive: boolean
) {
  let callCount = 0;

  const activeAccount = {
    bump: 255,
    version: 1,
    wallet: { toBase58: () => 'WalletPubkey' },
    name: 'ResearchBriefAgent',
    description: 'Test',
    agentId: null,
    agentUri: null,
    x402Endpoint: null,
    isActive: postRegisterIsActive,
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
    agent: {
      fetchNullable: vi.fn(async () => {
        callCount++;
        // First call returns the initial state; subsequent calls return the
        // post-register/reactivate state (simulating on-chain update).
        if (callCount === 1) {
          return initialAccount
            ? { ...activeAccount, isActive: initialAccount.isActive, name: initialAccount.name }
            : null;
        }
        return { ...activeAccount, isActive: postRegisterIsActive };
      }),
      register: vi.fn(async () => {}),
      reactivate: vi.fn(async () => {}),
      fetch: vi.fn(async () => ({ ...activeAccount, isActive: postRegisterIsActive })),
      deriveAgent: vi.fn(() => [{ toBase58: () => 'AgentPDA_fixed_address' }, 255]),
    },
    indexing: {
      initCapabilityIndex: vi.fn(async () => {}),
      addToCapabilityIndex: vi.fn(async () => {}),
    },
    tools: {
      publishByName: vi.fn(async () => {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Arbitraries for Property 6
// ---------------------------------------------------------------------------

/**
 * Generates one of three agent scenarios:
 *  - "new"      : no existing PDA (fresh registration)
 *  - "active"   : existing PDA with isActive === true (skip registration)
 *  - "inactive" : existing PDA with isActive === false (reactivation path)
 */
const agentScenarioArb = fc.oneof(
  fc.constant('new' as const),
  fc.constant('active' as const),
  fc.constant('inactive' as const)
);

describe('Property 6: SAP Registration Precondition', () => {
  it(
    '**Validates: Requirements 2.5, 2.1** — ensureRegistered() always returns an account with isActive === true for any valid scenario (new, active, inactive)',
    async () => {
      await fc.assert(
        fc.asyncProperty(agentScenarioArb, async (scenario) => {
          let initialAccount: { isActive: boolean; name: string } | null;

          switch (scenario) {
            case 'new':
              initialAccount = null;
              break;
            case 'active':
              initialAccount = { isActive: true, name: 'ResearchBriefAgent' };
              break;
            case 'inactive':
              initialAccount = { isActive: false, name: 'ResearchBriefAgent' };
              break;
          }

          // In all valid scenarios the post-register/reactivate state is active
          const client = buildPreconditionMockClient(initialAccount, /* postRegisterIsActive */ true);
          const registrar = new SapRegistrar(client);

          const account = await registrar.ensureRegistered(testConfig);

          // The precondition: isActive MUST be true before the pipeline proceeds
          expect(account.isActive).toBe(true);
        }),
        { numRuns: 20 }
      );
    }
  );

  it(
    '**Validates: Requirements 2.5** — ensureRegistered() throws RegistrationError when the SAP SDK returns isActive === false after fresh registration',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          // Only test the "new agent" path — the one that calls register()
          fc.constant('new' as const),
          async () => {
            // Simulate a broken SDK that registers but leaves isActive === false
            const client = buildPreconditionMockClient(null, /* postRegisterIsActive */ false);
            const registrar = new SapRegistrar(client);

            await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow(RegistrationError);
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    '**Validates: Requirements 2.5** — ensureRegistered() throws RegistrationError when the SAP SDK returns isActive === false after reactivation',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constant('inactive' as const),
          async () => {
            // Simulate a broken SDK that reactivates but leaves isActive === false
            const client = buildPreconditionMockClient(
              { isActive: false, name: 'ResearchBriefAgent' },
              /* postRegisterIsActive */ false
            );
            const registrar = new SapRegistrar(client);

            await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow(RegistrationError);
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    '**Validates: Requirements 2.1** — for any scenario, ensureRegistered() is called before any tool discovery or API call can proceed (register() is called at most once for a new agent)',
    async () => {
      await fc.assert(
        fc.asyncProperty(agentScenarioArb, async (scenario) => {
          let initialAccount: { isActive: boolean; name: string } | null;

          switch (scenario) {
            case 'new':
              initialAccount = null;
              break;
            case 'active':
              initialAccount = { isActive: true, name: 'ResearchBriefAgent' };
              break;
            case 'inactive':
              initialAccount = { isActive: false, name: 'ResearchBriefAgent' };
              break;
          }

          const client = buildPreconditionMockClient(initialAccount, true);
          const registrar = new SapRegistrar(client);

          await registrar.ensureRegistered(testConfig);

          // For a new agent: register() must be called exactly once
          if (scenario === 'new') {
            expect(client.agent.register).toHaveBeenCalledTimes(1);
            expect(client.agent.reactivate).not.toHaveBeenCalled();
          }

          // For an already-active agent: neither register() nor reactivate() is called
          if (scenario === 'active') {
            expect(client.agent.register).not.toHaveBeenCalled();
            expect(client.agent.reactivate).not.toHaveBeenCalled();
          }

          // For an inactive agent: reactivate() is called, register() is not
          if (scenario === 'inactive') {
            expect(client.agent.reactivate).toHaveBeenCalledTimes(1);
            expect(client.agent.register).not.toHaveBeenCalled();
          }
        }),
        { numRuns: 15 }
      );
    }
  );

  it(
    '**Validates: Requirements 2.5, 2.1** — isActive precondition holds across multiple independent registrar instances with different scenarios',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(agentScenarioArb, { minLength: 1, maxLength: 5 }),
          async (scenarios) => {
            for (const scenario of scenarios) {
              let initialAccount: { isActive: boolean; name: string } | null;

              switch (scenario) {
                case 'new':
                  initialAccount = null;
                  break;
                case 'active':
                  initialAccount = { isActive: true, name: 'ResearchBriefAgent' };
                  break;
                case 'inactive':
                  initialAccount = { isActive: false, name: 'ResearchBriefAgent' };
                  break;
              }

              const client = buildPreconditionMockClient(initialAccount, true);
              const registrar = new SapRegistrar(client);

              const account = await registrar.ensureRegistered(testConfig);

              // The precondition must hold for every independent registrar instance
              expect(account.isActive).toBe(true);
            }
          }
        ),
        { numRuns: 10 }
      );
    }
  );
});
