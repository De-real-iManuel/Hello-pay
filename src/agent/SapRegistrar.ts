/**
 * SapRegistrar — manages the agent's on-chain identity lifecycle on SAP mainnet.
 *
 * Responsibilities:
 *  - ensureRegistered: idempotent registration (create / reactivate / skip)
 *  - fetchProfile: return current AgentAccountData from SAP
 *  - publishToolSchemas: publish tool schemas to SAP indexing
 *  - After fresh registration, add agent PDA to capability indexes for all 4 capabilities
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7
 *
 * NOTE: The SAP SDK ships two SapClient variants:
 *   - Low-level (top-level export): raw instruction builders
 *   - High-level (core/client): ergonomic register/fetch/reactivate methods
 * SapRegistrar accepts the high-level client typed as `any` to avoid
 * subpath-export resolution issues, per the task's "best-effort TypeScript"
 * guidance.
 */

import BN from "bn.js";
import type { AgentAccountData } from "@oobe-protocol-labs/synapse-sap-sdk/types";
import { TokenType, SettlementMode } from "@oobe-protocol-labs/synapse-sap-sdk/types";
import { AgentRegistrationConfig } from "../types/index.js";
import { RegistrationError } from "../utils/errors.js";

// ---------------------------------------------------------------------------
// ToolSchema — minimal shape for publishToolSchemas
// ---------------------------------------------------------------------------

export interface ToolSchema {
  /** Human-readable tool name, e.g. "web_search" */
  name: string;
  /** Protocol namespace, e.g. "acedata" */
  protocolId: string;
  /** Short description */
  description: string;
  /** Tool category string, e.g. "data" */
  category?: string;
  /** HTTP method, e.g. "post" */
  httpMethod?: string;
  /** Total parameter count */
  paramsCount?: number;
  /** Required parameter count */
  requiredParams?: number;
}

// ---------------------------------------------------------------------------
// AgentProfile — a richer view returned by fetchProfile
// ---------------------------------------------------------------------------

export interface AgentProfile {
  /** On-chain AgentAccountData */
  account: AgentAccountData;
  /** Derived PDA address (base58) */
  agentPda: string;
}

// ---------------------------------------------------------------------------
// Capability IDs registered for this agent (Requirement 2.2)
// ---------------------------------------------------------------------------

const CAPABILITY_IDS = [
  "acedata:search",
  "acedata:llm",
  "acedata:image",
  "data:oracle",
] as const;

// ---------------------------------------------------------------------------
// SapRegistrar
// ---------------------------------------------------------------------------

export class SapRegistrar {
  /**
   * @param client - High-level SapClient from SapConnection.fromKeypair().
   *   Typed as `any` because the high-level client lives in the SDK's
   *   `core/client` module which has no subpath export in the package.json.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly client: any) {}

  // -------------------------------------------------------------------------
  // ensureRegistered
  // -------------------------------------------------------------------------

  /**
   * Idempotent registration:
   *  1. Fetch existing PDA → if active, return it immediately.
   *  2. If inactive, reactivate and return.
   *  3. If absent, register fresh with all 4 capabilities + standard pricing tier,
   *     then add agent PDA to all 4 capability indexes.
   *
   * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7
   */
  async ensureRegistered(
    config: AgentRegistrationConfig
  ): Promise<AgentAccountData> {
    // ── Step 1: check for existing account ──────────────────────────────────
    let existing: AgentAccountData | null = null;
    try {
      existing = await this.client.agent.fetchNullable() as AgentAccountData | null;
    } catch (_err) {
      // fetchNullable should not throw, but guard defensively
      existing = null;
    }

    // ── Step 2: active → return immediately (Requirement 2.3) ───────────────
    if (existing !== null && existing.isActive) {
      return existing;
    }

    // ── Step 3: inactive → reactivate (Requirement 2.4) ─────────────────────
    if (existing !== null && !existing.isActive) {
      try {
        await this.client.agent.reactivate();
      } catch (err) {
        throw new RegistrationError(
          `Failed to reactivate agent: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const reactivated = await this.client.agent.fetchNullable() as AgentAccountData | null;
      if (!reactivated || !reactivated.isActive) {
        throw new RegistrationError(
          "Agent reactivation succeeded but isActive is still false after fetch."
        );
      }
      return reactivated;
    }

    // ── Step 4: absent → fresh registration (Requirement 2.1) ───────────────
    const capabilities = config.capabilities.map((cap) => ({
      id: cap.id,
      description: cap.description ?? null,
      protocolId: cap.protocolId ?? null,
      version: cap.version ?? null,
    }));

    // Build the standard pricing tier (Requirement 2.7)
    const pricing = [
      {
        tierId: "standard",
        pricePerCall: new BN(1000),
        minPricePerCall: null,
        maxPricePerCall: null,
        rateLimit: 10,
        maxCallsPerSession: 1000,
        burstLimit: null,
        tokenType: TokenType.Sol,
        tokenMint: null,
        tokenDecimals: null,
        settlementMode: SettlementMode.X402,
        minEscrowDeposit: null,
        batchIntervalSec: null,
        volumeCurve: null,
      },
    ];

    try {
      await this.client.agent.register({
        name: config.name,
        description: config.description,
        capabilities,
        pricing,
        protocols: config.protocols,
        x402Endpoint: config.x402Endpoint ?? null,
      });
    } catch (err) {
      throw new RegistrationError(
        `Agent registration failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── Step 5: add to capability indexes (Requirement 2.2) ─────────────────
    await this._ensureCapabilityIndexes();

    // ── Step 6: verify isActive === true (Requirement 2.5) ──────────────────
    const registered = await this.client.agent.fetchNullable() as AgentAccountData | null;
    if (!registered) {
      throw new RegistrationError(
        "Agent registration appeared to succeed but account not found on-chain."
      );
    }
    if (!registered.isActive) {
      throw new RegistrationError(
        "Agent was registered but isActive is false — unexpected state."
      );
    }

    return registered;
  }

  // -------------------------------------------------------------------------
  // fetchProfile
  // -------------------------------------------------------------------------

  /**
   * Return the current AgentProfile (account data + PDA address) from SAP.
   */
  async fetchProfile(): Promise<AgentProfile> {
    const account = await this.client.agent.fetch() as AgentAccountData;
    const [agentPda] = this.client.agent.deriveAgent() as [{ toBase58(): string }, number];
    return {
      account,
      agentPda: agentPda.toBase58(),
    };
  }

  // -------------------------------------------------------------------------
  // publishToolSchemas
  // -------------------------------------------------------------------------

  /**
   * Publish tool schemas to SAP indexing for discoverability.
   * Uses client.tools.publishByName for each tool schema provided.
   */
  async publishToolSchemas(tools: ToolSchema[]): Promise<void> {
    for (const tool of tools) {
      try {
        // publishByName(name, protocolId, description, inputSchema, outputSchema,
        //               version, httpMethod, category, paramsCount, requiredParams, isCompound)
        await this.client.tools.publishByName(
          tool.name,
          tool.protocolId,
          tool.description,
          /* inputSchema  */ null,
          /* outputSchema */ null,
          /* version      */ 1,
          /* httpMethod   */ tool.httpMethod === "get" ? 0 : 1, // 0=GET, 1=POST
          /* category     */ 0, // Custom
          /* paramsCount  */ tool.paramsCount ?? 0,
          /* requiredParams */ tool.requiredParams ?? 0,
          /* isCompound   */ false
        );
      } catch (err) {
        // Non-fatal: log and continue — tool schema publishing is best-effort
        console.warn(
          `[SapRegistrar] Failed to publish tool schema for "${tool.name}": ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure the agent is listed in all 4 capability indexes.
   * Tries initCapabilityIndex first (creates + adds); if the index already
   * exists the SDK will throw, so we fall back to addToCapabilityIndex.
   *
   * Requirements: 2.2
   */
  private async _ensureCapabilityIndexes(): Promise<void> {
    for (const capId of CAPABILITY_IDS) {
      await this._addToCapabilityIndex(capId);
    }
  }

  private async _addToCapabilityIndex(capabilityId: string): Promise<void> {
    // First try to init (creates the index and adds the agent in one TX)
    try {
      await this.client.indexing.initCapabilityIndex(capabilityId);
      return;
    } catch (_initErr) {
      // Index likely already exists — fall through to addToCapabilityIndex
    }

    // Index exists — just add the agent
    try {
      await this.client.indexing.addToCapabilityIndex(capabilityId);
    } catch (addErr) {
      // If the agent is already in the index the SDK may throw a duplicate error.
      // Treat that as a success (idempotent).
      const msg =
        addErr instanceof Error ? addErr.message.toLowerCase() : String(addErr);
      const isDuplicate =
        msg.includes("already") ||
        msg.includes("duplicate") ||
        msg.includes("exists") ||
        msg.includes("0x0"); // Anchor account-already-in-use code

      if (!isDuplicate) {
        console.warn(
          `[SapRegistrar] Could not add agent to capability index "${capabilityId}": ${msg}`
        );
      }
    }
  }
}
