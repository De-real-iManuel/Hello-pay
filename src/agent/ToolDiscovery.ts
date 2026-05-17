/**
 * ToolDiscovery — queries SAP on-chain indexes to find agents by capability
 * and verifies the Synapse Sentinel agent is active and x402-capable.
 *
 * Responsibilities:
 *  - findSentinel(): locate Sentinel by wallet, verify isActive + hasX402
 *  - findAgentsByCapability(capabilityId): generic capability query
 *  - verifyAgentActive(agentWallet): boolean active check
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 *
 * NOTE: The SAP SDK's DiscoveryRegistry returns `DiscoveredAgent[]` from
 * `findAgentsByCapability` and `AgentProfile | null` from `getAgentProfile`.
 * The SDK's `AgentProfile` type lives in an internal module with no subpath
 * export, so we mirror its shape locally (same pattern as SapRegistrar using
 * `any` for the client).
 */

import type { PublicKey } from "@solana/web3.js";
import type { AgentAccountData, AgentStatsData } from "@oobe-protocol-labs/synapse-sap-sdk/types";

// ---------------------------------------------------------------------------
// Local mirror of the SDK's AgentProfile type
// (SDK's DiscoveryRegistry.AgentProfile has no subpath export)
// ---------------------------------------------------------------------------

/**
 * Full agent profile returned by `client.discovery.getAgentProfile()`.
 * Mirrors the SDK's `AgentProfile` interface from `registries/discovery`.
 */
export interface AgentProfile {
  /** Agent PDA address. */
  readonly pda: PublicKey;
  /** Agent identity (name, description, capabilities, pricing, etc.). */
  readonly identity: AgentAccountData;
  /** Lightweight metrics (total calls, active status). */
  readonly stats: AgentStatsData | null;
  /** Computed fields for display. */
  readonly computed: {
    /** Is the agent currently active? */
    readonly isActive: boolean;
    /** Total calls served (from stats or identity fallback). */
    readonly totalCalls: string;
    /** Reputation score (0-1000). */
    readonly reputationScore: number;
    /** Has x402 endpoint configured? */
    readonly hasX402: boolean;
    /** Number of capabilities. */
    readonly capabilityCount: number;
    /** Number of pricing tiers. */
    readonly pricingTierCount: number;
    /** Protocol list. */
    readonly protocols: string[];
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The SAP capability ID used by Synapse Sentinel to expose SynapseAgentKit
 * tools (including Pyth price feeds) via x402.
 *
 * Requirements: 3.1
 */
const SENTINEL_CAPABILITY_ID = "synapse-agent-kit:gateway";

/**
 * The Synapse Sentinel agent's wallet address on Solana mainnet.
 *
 * Requirements: 3.2
 */
const SENTINEL_WALLET = "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph";

// ---------------------------------------------------------------------------
// ToolDiscovery
// ---------------------------------------------------------------------------

export class ToolDiscovery {
  /**
   * @param client - High-level SapClient from SapConnection.fromKeypair().
   *   Typed as `any` because the high-level client lives in the SDK's
   *   `core/client` module which has no subpath export in the package.json.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly client: any) {}

  // -------------------------------------------------------------------------
  // findSentinel
  // -------------------------------------------------------------------------

  /**
   * Locate the Synapse Sentinel agent via SAP capability indexes and verify
   * it is active and x402-capable.
   *
   * Steps:
   *  1. Query `client.discovery.findAgentsByCapability("synapse-agent-kit:gateway")`
   *  2. Find the entry whose `identity.wallet` matches the Sentinel wallet address
   *  3. Fetch the full `AgentProfile` via `client.discovery.getAgentProfile()`
   *  4. Verify `computed.isActive === true` and `computed.hasX402 === true`
   *  5. Return the `AgentProfile` for use in payment preparation
   *
   * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
   *
   * @throws Error if the capability index is empty or Sentinel is not found
   * @throws Error if Sentinel has `isActive === false` or `hasX402 === false`
   */
  async findSentinel(): Promise<AgentProfile> {
    // Step 1: Query the capability index (Requirement 3.1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discovered: any[] = await this.client.discovery.findAgentsByCapability(
      SENTINEL_CAPABILITY_ID
    );

    // Step 2: Guard — empty results (Requirement 3.4)
    if (!discovered || discovered.length === 0) {
      throw new Error(
        `[ToolDiscovery] No agents found for capability "${SENTINEL_CAPABILITY_ID}". ` +
          `Synapse Sentinel (${SENTINEL_WALLET}) is not registered or the index is empty.`
      );
    }

    // Step 3: Locate the Sentinel entry by wallet address (Requirement 3.2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sentinelEntry = discovered.find((agent: any) => {
      const wallet: PublicKey | null | undefined = agent?.identity?.wallet;
      if (!wallet) return false;
      const walletStr =
        typeof (wallet as PublicKey).toBase58 === "function"
          ? (wallet as PublicKey).toBase58()
          : String(wallet);
      return walletStr === SENTINEL_WALLET;
    });

    if (!sentinelEntry) {
      throw new Error(
        `[ToolDiscovery] Synapse Sentinel (wallet: ${SENTINEL_WALLET}) was not found ` +
          `in the "${SENTINEL_CAPABILITY_ID}" capability index. ` +
          `Found ${discovered.length} agent(s) but none matched the Sentinel wallet.`
      );
    }

    // Step 4: Fetch the full AgentProfile for the Sentinel wallet (Requirement 3.3)
    const sentinelWallet: PublicKey = sentinelEntry.identity.wallet as PublicKey;
    const profile: AgentProfile | null =
      await this.client.discovery.getAgentProfile(sentinelWallet);

    if (!profile) {
      throw new Error(
        `[ToolDiscovery] Could not fetch AgentProfile for Synapse Sentinel ` +
          `(wallet: ${SENTINEL_WALLET}). The account may have been closed.`
      );
    }

    // Step 5: Verify isActive and hasX402 flags (Requirement 3.2, 3.5)
    if (!profile.computed.isActive) {
      throw new Error(
        `[ToolDiscovery] Synapse Sentinel (wallet: ${SENTINEL_WALLET}) is not active ` +
          `(isActive === false). The Sentinel agent is currently unavailable.`
      );
    }

    if (!profile.computed.hasX402) {
      throw new Error(
        `[ToolDiscovery] Synapse Sentinel (wallet: ${SENTINEL_WALLET}) does not have ` +
          `an x402 endpoint configured (hasX402 === false). ` +
          `The Sentinel agent cannot accept x402 payments.`
      );
    }

    // Step 6: Return the verified profile (Requirement 3.3)
    return profile;
  }

  // -------------------------------------------------------------------------
  // findAgentsByCapability
  // -------------------------------------------------------------------------

  /**
   * Generic capability query — returns all `AgentProfile[]` for agents
   * registered under the given capability ID.
   *
   * Agents whose `identity` is null (PDA exists in index but account not
   * found on-chain) are silently filtered out.
   *
   * Requirements: 3.1
   *
   * @param capabilityId - The capability identifier string (e.g. `"acedata:search"`)
   * @returns Array of `AgentProfile` for all agents with this capability
   */
  async findAgentsByCapability(capabilityId: string): Promise<AgentProfile[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const discovered: any[] = await this.client.discovery.findAgentsByCapability(
      capabilityId
    );

    if (!discovered || discovered.length === 0) {
      return [];
    }

    // Hydrate each discovered agent into a full AgentProfile
    const profiles: AgentProfile[] = [];
    for (const agent of discovered) {
      if (!agent?.identity?.wallet) continue;

      const profile: AgentProfile | null =
        await this.client.discovery.getAgentProfile(agent.identity.wallet as PublicKey);

      if (profile) {
        profiles.push(profile);
      }
    }

    return profiles;
  }

  // -------------------------------------------------------------------------
  // verifyAgentActive
  // -------------------------------------------------------------------------

  /**
   * Check whether an agent identified by its wallet public key is currently
   * active on SAP.
   *
   * Delegates to `client.discovery.isAgentActive()` which reads the agent
   * stats account for a lightweight active-status check.
   *
   * Requirements: 3.2
   *
   * @param agentWallet - The agent owner's wallet public key
   * @returns `true` if the agent exists and is active, `false` otherwise
   */
  async verifyAgentActive(agentWallet: PublicKey): Promise<boolean> {
    try {
      return await this.client.discovery.isAgentActive(agentWallet);
    } catch (_err) {
      // If the account doesn't exist or the call fails, treat as inactive
      return false;
    }
  }
}
