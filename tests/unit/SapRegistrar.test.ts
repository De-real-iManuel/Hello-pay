/**
 * Unit tests for SapRegistrar.
 *
 * Tests the three public methods:
 *  - ensureRegistered(config): idempotent registration
 *  - fetchProfile(): returns AgentProfile
 *  - publishToolSchemas(tools): publishes tool schemas (best-effort)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SapRegistrar } from '../../src/agent/SapRegistrar.js';
import { RegistrationError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Shared mock data
// ---------------------------------------------------------------------------

const mockActiveAccount = {
  bump: 255,
  version: 1,
  wallet: { toBase58: () => 'WalletPubkey123' },
  name: 'ResearchBriefAgent',
  description: 'Test agent',
  agentId: null,
  agentUri: null,
  x402Endpoint: null,
  isActive: true,
  createdAt: { toNumber: () => 1000000 },
  updatedAt: { toNumber: () => 1000000 },
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

const mockInactiveAccount = { ...mockActiveAccount, isActive: false };

const testConfig = {
  name: 'ResearchBriefAgent',
  description: 'Test agent',
  capabilities: [
    { id: 'acedata:search', protocolId: 'acedata', version: '1.0', description: 'Web search' },
    { id: 'acedata:llm',    protocolId: 'acedata', version: '1.0', description: 'LLM' },
    { id: 'acedata:image',  protocolId: 'acedata', version: '1.0', description: 'Image gen' },
    { id: 'data:oracle',   protocolId: 'pyth',    version: '1.0', description: 'Price oracle' },
  ],
  protocols: ['A2A', 'MCP', 'acedata'],
  x402Endpoint: 'https://agent.example.com',
};

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function buildMockClient(overrides?: Partial<{
  fetchNullable: () => Promise<typeof mockActiveAccount | null>;
  register: () => Promise<void>;
  reactivate: () => Promise<void>;
  fetch: () => Promise<typeof mockActiveAccount>;
  deriveAgent: () => [{ toBase58(): string }, number];
  initCapabilityIndex: (id: string) => Promise<void>;
  addToCapabilityIndex: (id: string) => Promise<void>;
  publishByName: (...args: unknown[]) => Promise<void>;
}>) {
  return {
    agent: {
      fetchNullable: overrides?.fetchNullable ?? vi.fn().mockResolvedValue(null),
      register:      overrides?.register      ?? vi.fn().mockResolvedValue(undefined),
      reactivate:    overrides?.reactivate    ?? vi.fn().mockResolvedValue(undefined),
      fetch:         overrides?.fetch         ?? vi.fn().mockResolvedValue(mockActiveAccount),
      deriveAgent:   overrides?.deriveAgent   ?? vi.fn().mockReturnValue([{ toBase58: () => 'AgentPDA123' }, 255]),
    },
    indexing: {
      initCapabilityIndex: overrides?.initCapabilityIndex ?? vi.fn().mockResolvedValue(undefined),
      addToCapabilityIndex: overrides?.addToCapabilityIndex ?? vi.fn().mockResolvedValue(undefined),
    },
    tools: {
      publishByName: overrides?.publishByName ?? vi.fn().mockResolvedValue(undefined),
    },
  };
}

// ---------------------------------------------------------------------------
// ensureRegistered
// ---------------------------------------------------------------------------

describe('SapRegistrar.ensureRegistered', () => {
  // ── Test 1: New agent (no existing PDA) ──────────────────────────────────
  it('calls register() once for a new agent and populates capability indexes', async () => {
    // fetchNullable returns null first (no account), then returns active account
    // after registration (for the isActive verification step)
    const fetchNullable = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockActiveAccount);

    const register = vi.fn().mockResolvedValue(undefined);
    const initCapabilityIndex = vi.fn().mockResolvedValue(undefined);

    const client = buildMockClient({ fetchNullable, register, initCapabilityIndex });
    const registrar = new SapRegistrar(client);

    const result = await registrar.ensureRegistered(testConfig);

    // register() called exactly once
    expect(register).toHaveBeenCalledTimes(1);

    // capability indexes populated for all 4 capabilities
    expect(initCapabilityIndex).toHaveBeenCalledTimes(4);
    expect(initCapabilityIndex).toHaveBeenCalledWith('acedata:search');
    expect(initCapabilityIndex).toHaveBeenCalledWith('acedata:llm');
    expect(initCapabilityIndex).toHaveBeenCalledWith('acedata:image');
    expect(initCapabilityIndex).toHaveBeenCalledWith('data:oracle');

    // returned account is active
    expect(result.isActive).toBe(true);
  });

  // ── Test 2: Active agent (existing active PDA) ───────────────────────────
  it('skips register() when agent is already active', async () => {
    const fetchNullable = vi.fn().mockResolvedValue(mockActiveAccount);
    const register = vi.fn().mockResolvedValue(undefined);

    const client = buildMockClient({ fetchNullable, register });
    const registrar = new SapRegistrar(client);

    const result = await registrar.ensureRegistered(testConfig);

    // register() must NOT be called
    expect(register).not.toHaveBeenCalled();

    // returns the existing active account
    expect(result).toBe(mockActiveAccount);
  });

  // ── Test 3: Inactive agent (existing inactive PDA) ───────────────────────
  it('calls reactivate() for an inactive agent and does NOT call register()', async () => {
    // First call returns inactive account; second call (after reactivate) returns active
    const fetchNullable = vi.fn()
      .mockResolvedValueOnce(mockInactiveAccount)
      .mockResolvedValueOnce(mockActiveAccount);

    const register = vi.fn().mockResolvedValue(undefined);
    const reactivate = vi.fn().mockResolvedValue(undefined);

    const client = buildMockClient({ fetchNullable, register, reactivate });
    const registrar = new SapRegistrar(client);

    const result = await registrar.ensureRegistered(testConfig);

    // reactivate() called once
    expect(reactivate).toHaveBeenCalledTimes(1);

    // register() must NOT be called
    expect(register).not.toHaveBeenCalled();

    // returns the reactivated (active) account
    expect(result.isActive).toBe(true);
  });

  // ── Test 4: Registration failure ─────────────────────────────────────────
  it('throws RegistrationError when register() throws', async () => {
    const fetchNullable = vi.fn().mockResolvedValue(null);
    const register = vi.fn().mockRejectedValue(new Error('Transaction rejected'));

    const client = buildMockClient({ fetchNullable, register });
    const registrar = new SapRegistrar(client);

    await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow(RegistrationError);
    await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow('Transaction rejected');
  });

  // ── Test 5: Reactivation failure ─────────────────────────────────────────
  it('throws RegistrationError when reactivate() throws', async () => {
    const fetchNullable = vi.fn().mockResolvedValue(mockInactiveAccount);
    const reactivate = vi.fn().mockRejectedValue(new Error('Reactivation failed'));

    const client = buildMockClient({ fetchNullable, reactivate });
    const registrar = new SapRegistrar(client);

    await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow(RegistrationError);
    await expect(registrar.ensureRegistered(testConfig)).rejects.toThrow('Reactivation failed');
  });

  // ── Test 6: Post-registration isActive check ─────────────────────────────
  it('throws RegistrationError when post-registration fetch returns isActive: false', async () => {
    // fetchNullable: first call → null (no account), second call → inactive account
    const fetchNullable = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(mockInactiveAccount);

    const register = vi.fn().mockResolvedValue(undefined);

    const client = buildMockClient({ fetchNullable, register });
    const registrar = new SapRegistrar(client);

    let caughtError: unknown;
    try {
      await registrar.ensureRegistered(testConfig);
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(RegistrationError);
    expect((caughtError as RegistrationError).message).toMatch(/isActive is false/);
  });
});

// ---------------------------------------------------------------------------
// fetchProfile
// ---------------------------------------------------------------------------

describe('SapRegistrar.fetchProfile', () => {
  // ── Test 7: Returns AgentProfile with account and agentPda ───────────────
  it('returns AgentProfile with account and agentPda string', async () => {
    const client = buildMockClient();
    const registrar = new SapRegistrar(client);

    const profile = await registrar.fetchProfile();

    expect(profile).toHaveProperty('account');
    expect(profile).toHaveProperty('agentPda');
    expect(profile.account).toBe(mockActiveAccount);
    expect(typeof profile.agentPda).toBe('string');
    expect(profile.agentPda).toBe('AgentPDA123');
  });
});

// ---------------------------------------------------------------------------
// publishToolSchemas
// ---------------------------------------------------------------------------

describe('SapRegistrar.publishToolSchemas', () => {
  const sampleTools = [
    { name: 'web_search', protocolId: 'acedata', description: 'Web search tool' },
    { name: 'llm_chat',   protocolId: 'acedata', description: 'LLM chat tool' },
  ];

  // ── Test 8: Calls publishByName for each tool ─────────────────────────────
  it('calls client.tools.publishByName for each tool schema', async () => {
    const publishByName = vi.fn().mockResolvedValue(undefined);
    const client = buildMockClient({ publishByName });
    const registrar = new SapRegistrar(client);

    await registrar.publishToolSchemas(sampleTools);

    expect(publishByName).toHaveBeenCalledTimes(2);
    // First call should include the tool name as first argument
    expect(publishByName).toHaveBeenNthCalledWith(
      1,
      'web_search',
      'acedata',
      'Web search tool',
      null,   // inputSchema
      null,   // outputSchema
      1,      // version
      1,      // httpMethod (POST default)
      0,      // category (Custom)
      0,      // paramsCount
      0,      // requiredParams
      false   // isCompound
    );
    expect(publishByName).toHaveBeenNthCalledWith(
      2,
      'llm_chat',
      'acedata',
      'LLM chat tool',
      null, null, 1, 1, 0, 0, 0, false
    );
  });

  // ── Test 9: Does NOT throw if publishByName fails (best-effort) ───────────
  it('does not throw when publishByName fails for a tool', async () => {
    const publishByName = vi.fn().mockRejectedValue(new Error('Publish failed'));
    const client = buildMockClient({ publishByName });
    const registrar = new SapRegistrar(client);

    // Should resolve without throwing
    await expect(registrar.publishToolSchemas(sampleTools)).resolves.toBeUndefined();

    // publishByName was still called for each tool
    expect(publishByName).toHaveBeenCalledTimes(2);
  });
});
