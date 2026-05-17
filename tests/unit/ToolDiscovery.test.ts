/**
 * Unit tests for ToolDiscovery.
 *
 * Tests the three public methods:
 *  - findSentinel(): locate Sentinel, verify isActive + hasX402
 *  - findAgentsByCapability(capabilityId): generic capability query
 *  - verifyAgentActive(agentWallet): boolean active check
 *
 * Requirements: 3.4, 3.5
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolDiscovery } from '../../src/agent/ToolDiscovery.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_WALLET = 'Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph';
const OTHER_WALLET    = 'SomeOtherAgent1111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function makeWallet(address: string) {
  return { toBase58: () => address };
}

function makeDiscoveredAgent(walletAddress: string) {
  return {
    pda: makeWallet('AgentPDA_' + walletAddress.slice(0, 8)),
    identity: {
      wallet: makeWallet(walletAddress),
      name: 'TestAgent',
      isActive: true,
      x402Endpoint: 'https://agent.example.com',
      capabilities: [],
      pricing: [],
      protocols: [],
    },
    stats: null,
  };
}

function makeAgentProfile(
  walletAddress: string,
  opts: { isActive?: boolean; hasX402?: boolean } = {}
) {
  const { isActive = true, hasX402 = true } = opts;
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
// Mock client factory
// ---------------------------------------------------------------------------

function buildMockClient(overrides?: {
  findAgentsByCapability?: (capabilityId: string) => Promise<unknown[]>;
  getAgentProfile?: (wallet: unknown) => Promise<unknown | null>;
  isAgentActive?: (wallet: unknown) => Promise<boolean>;
}) {
  return {
    discovery: {
      findAgentsByCapability:
        overrides?.findAgentsByCapability ??
        vi.fn().mockResolvedValue([]),
      getAgentProfile:
        overrides?.getAgentProfile ??
        vi.fn().mockResolvedValue(null),
      isAgentActive:
        overrides?.isAgentActive ??
        vi.fn().mockResolvedValue(false),
    },
  };
}

// ---------------------------------------------------------------------------
// findSentinel
// ---------------------------------------------------------------------------

describe('ToolDiscovery.findSentinel', () => {
  // ── Test 1: Happy path — Sentinel found, active, hasX402 ─────────────────
  it('returns Sentinel AgentProfile when found, active, and hasX402', async () => {
    const sentinelProfile = makeAgentProfile(SENTINEL_WALLET, { isActive: true, hasX402: true });
    const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([sentinelDiscovered]),
      getAgentProfile: vi.fn().mockResolvedValue(sentinelProfile),
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.findSentinel();

    expect(result).toBe(sentinelProfile);
    expect(client.discovery.findAgentsByCapability).toHaveBeenCalledWith(
      'synapse-agent-kit:gateway'
    );
  });

  // ── Test 2: Empty discovery results → throws descriptive error ────────────
  it('throws descriptive error when discovery returns empty list', async () => {
    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([]),
    });

    const discovery = new ToolDiscovery(client);

    await expect(discovery.findSentinel()).rejects.toThrow(
      /No agents found for capability "synapse-agent-kit:gateway"/
    );
    await expect(discovery.findSentinel()).rejects.toThrow(SENTINEL_WALLET);
  });

  // ── Test 3: Sentinel not in results → throws descriptive error ────────────
  it('throws descriptive error when Sentinel wallet is not in discovery results', async () => {
    const otherAgent = makeDiscoveredAgent(OTHER_WALLET);

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([otherAgent]),
      getAgentProfile: vi.fn().mockResolvedValue(makeAgentProfile(OTHER_WALLET)),
    });

    const discovery = new ToolDiscovery(client);

    await expect(discovery.findSentinel()).rejects.toThrow(
      /Synapse Sentinel.*was not found/
    );
    await expect(discovery.findSentinel()).rejects.toThrow(SENTINEL_WALLET);
  });

  // ── Test 4: Sentinel with isActive: false → throws error ─────────────────
  it('throws error when Sentinel has isActive === false', async () => {
    const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
    const inactiveProfile = makeAgentProfile(SENTINEL_WALLET, { isActive: false, hasX402: true });

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([sentinelDiscovered]),
      getAgentProfile: vi.fn().mockResolvedValue(inactiveProfile),
    });

    const discovery = new ToolDiscovery(client);

    await expect(discovery.findSentinel()).rejects.toThrow(
      /isActive === false/
    );
    await expect(discovery.findSentinel()).rejects.toThrow(
      /currently unavailable/
    );
  });

  // ── Test 5: Sentinel with hasX402: false → throws error ──────────────────
  it('throws error when Sentinel has hasX402 === false', async () => {
    const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
    const noX402Profile = makeAgentProfile(SENTINEL_WALLET, { isActive: true, hasX402: false });

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([sentinelDiscovered]),
      getAgentProfile: vi.fn().mockResolvedValue(noX402Profile),
    });

    const discovery = new ToolDiscovery(client);

    await expect(discovery.findSentinel()).rejects.toThrow(
      /hasX402 === false/
    );
    await expect(discovery.findSentinel()).rejects.toThrow(
      /cannot accept x402 payments/
    );
  });

  // ── Test 6: getAgentProfile returns null → throws error ──────────────────
  it('throws error when getAgentProfile returns null for Sentinel', async () => {
    const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([sentinelDiscovered]),
      getAgentProfile: vi.fn().mockResolvedValue(null),
    });

    const discovery = new ToolDiscovery(client);

    await expect(discovery.findSentinel()).rejects.toThrow(
      /Could not fetch AgentProfile for Synapse Sentinel/
    );
  });

  // ── Test 7: Multiple agents in results, Sentinel is one of them ───────────
  it('correctly identifies Sentinel among multiple agents', async () => {
    const otherAgent = makeDiscoveredAgent(OTHER_WALLET);
    const sentinelDiscovered = makeDiscoveredAgent(SENTINEL_WALLET);
    const sentinelProfile = makeAgentProfile(SENTINEL_WALLET, { isActive: true, hasX402: true });

    const getAgentProfile = vi.fn().mockImplementation((wallet: unknown) => {
      const addr = (wallet as { toBase58(): string }).toBase58();
      if (addr === SENTINEL_WALLET) return Promise.resolve(sentinelProfile);
      return Promise.resolve(makeAgentProfile(OTHER_WALLET));
    });

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([otherAgent, sentinelDiscovered]),
      getAgentProfile,
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.findSentinel();

    expect(result).toBe(sentinelProfile);
  });
});

// ---------------------------------------------------------------------------
// findAgentsByCapability
// ---------------------------------------------------------------------------

describe('ToolDiscovery.findAgentsByCapability', () => {
  // ── Test 8: Returns empty array when no agents found ─────────────────────
  it('returns empty array when discovery returns no agents', async () => {
    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([]),
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.findAgentsByCapability('acedata:search');

    expect(result).toEqual([]);
  });

  // ── Test 9: Returns hydrated profiles for found agents ───────────────────
  it('returns AgentProfile array for discovered agents', async () => {
    const agent1 = makeDiscoveredAgent('Agent1111111111111111111111111111111111111');
    const agent2 = makeDiscoveredAgent('Agent2222222222222222222222222222222222222');
    const profile1 = makeAgentProfile('Agent1111111111111111111111111111111111111');
    const profile2 = makeAgentProfile('Agent2222222222222222222222222222222222222');

    const getAgentProfile = vi.fn()
      .mockResolvedValueOnce(profile1)
      .mockResolvedValueOnce(profile2);

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([agent1, agent2]),
      getAgentProfile,
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.findAgentsByCapability('acedata:search');

    expect(result).toHaveLength(2);
    expect(result[0]).toBe(profile1);
    expect(result[1]).toBe(profile2);
  });

  // ── Test 10: Filters out agents with null identity ────────────────────────
  it('filters out agents with null identity.wallet', async () => {
    const agentWithNoIdentity = { pda: makeWallet('SomePDA'), identity: null, stats: null };
    const validAgent = makeDiscoveredAgent('Agent1111111111111111111111111111111111111');
    const validProfile = makeAgentProfile('Agent1111111111111111111111111111111111111');

    const getAgentProfile = vi.fn().mockResolvedValue(validProfile);

    const client = buildMockClient({
      findAgentsByCapability: vi.fn().mockResolvedValue([agentWithNoIdentity, validAgent]),
      getAgentProfile,
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.findAgentsByCapability('acedata:search');

    // Only the valid agent should be returned
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(validProfile);
  });

  // ── Test 11: Passes the correct capabilityId to the SDK ──────────────────
  it('passes the correct capabilityId to client.discovery.findAgentsByCapability', async () => {
    const findAgentsByCapability = vi.fn().mockResolvedValue([]);
    const client = buildMockClient({ findAgentsByCapability });

    const discovery = new ToolDiscovery(client);
    await discovery.findAgentsByCapability('my-custom:capability');

    expect(findAgentsByCapability).toHaveBeenCalledWith('my-custom:capability');
  });
});

// ---------------------------------------------------------------------------
// verifyAgentActive
// ---------------------------------------------------------------------------

describe('ToolDiscovery.verifyAgentActive', () => {
  const mockWallet = makeWallet(SENTINEL_WALLET);

  // ── Test 12: Returns true when agent is active ────────────────────────────
  it('returns true when isAgentActive returns true', async () => {
    const client = buildMockClient({
      isAgentActive: vi.fn().mockResolvedValue(true),
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.verifyAgentActive(mockWallet as unknown as import('@solana/web3.js').PublicKey);

    expect(result).toBe(true);
  });

  // ── Test 13: Returns false when agent is inactive ─────────────────────────
  it('returns false when isAgentActive returns false', async () => {
    const client = buildMockClient({
      isAgentActive: vi.fn().mockResolvedValue(false),
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.verifyAgentActive(mockWallet as unknown as import('@solana/web3.js').PublicKey);

    expect(result).toBe(false);
  });

  // ── Test 14: Returns false when isAgentActive throws ─────────────────────
  it('returns false (does not throw) when isAgentActive throws', async () => {
    const client = buildMockClient({
      isAgentActive: vi.fn().mockRejectedValue(new Error('Account not found')),
    });

    const discovery = new ToolDiscovery(client);
    const result = await discovery.verifyAgentActive(mockWallet as unknown as import('@solana/web3.js').PublicKey);

    expect(result).toBe(false);
  });
});
