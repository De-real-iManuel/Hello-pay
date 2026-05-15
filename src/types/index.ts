/**
 * Shared TypeScript interfaces for the Autonomous Bounty Agent.
 *
 * All types used across the pipeline are defined and exported from this
 * single barrel file so that every component imports from one place.
 *
 * Requirements: 9.1, 9.2, 15.1
 */

// ---------------------------------------------------------------------------
// Primitive / utility types
// ---------------------------------------------------------------------------

/**
 * A single web-search result returned by the AceDataCloud Web Search API.
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
}

/**
 * The result of a Midjourney image-generation call via AceDataCloud.
 */
export interface ImageResult {
  imageUrl: string;
  taskId: string;
  paymentTxHash: string;
}

/**
 * A single message in an LLM chat conversation.
 */
export interface ChatMessage {
  role: "user" | "system" | "assistant";
  content: string;
}

/**
 * A live asset price retrieved from the Pyth oracle via Synapse Sentinel.
 */
export interface PriceResult {
  asset: string;
  price: number;
  confidence: number;
  timestamp: number;
  settlementTx: string;
}

/**
 * A capability that an agent advertises in its SAP registration.
 */
export interface Capability {
  id: string;
  protocolId: string;
  version: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Payment / on-chain record types
// ---------------------------------------------------------------------------

/**
 * A record of a single x402 USDC settlement for one API call.
 */
export interface PaymentRecord {
  service: "sentinel" | "acedata-search" | "acedata-llm" | "acedata-image";
  network: "solana" | "base";
  /** USDC amount as a decimal string, e.g. "0.095215" */
  amountUsdc: string;
  txHash: string;
  settledAt: number;
}

/**
 * The on-chain ledger entry written by the SAP LedgerModule after a
 * successful pipeline run.
 */
export interface OnChainRecord {
  /** Solana TX signature of the ledger.append() call */
  ledgerTx: string;
  /** SHA-256 of the serialised ResearchBrief */
  contentHash: string;
  /** Agent's PDA address */
  agentPda: string;
}

/**
 * A ledger entry returned by ResultPersister.persist() or fetchHistory().
 */
export interface LedgerEntry {
  /** Confirmed Solana transaction signature */
  tx: string;
  /** SHA-256 of the serialised ResearchBrief */
  contentHash: string;
  /** Agent's PDA address */
  agentPda: string;
}

// ---------------------------------------------------------------------------
// Core output artifact
// ---------------------------------------------------------------------------

/**
 * The final output artifact produced by a successful pipeline run.
 * Contains all research data, payment proofs, and the on-chain ledger
 * reference.
 *
 * Requirements: 9.1, 15.1–15.9
 */
export interface ResearchBrief {
  /** UUID v4 generated fresh for each pipeline run */
  id: string;
  /** The input research topic */
  topic: string;
  /** Unix timestamp (seconds) recorded at the start of run() */
  createdAt: number;
  /** SOL/USD price from Pyth oracle via Synapse Sentinel (must be > 0) */
  solPrice: number;
  /** Raw results from AceDataCloud Web Search */
  searchResults: SearchResult[];
  /** LLM-generated synthesis of the search results */
  analysis: string;
  /** Midjourney cover image URL (valid HTTPS URL) */
  imageUrl: string;
  /** All x402 settlement records — exactly 4 entries per successful run */
  payments: PaymentRecord[];
  /** SAP LedgerModule entry for this brief */
  onChain: OnChainRecord;
}

// ---------------------------------------------------------------------------
// Pipeline state (internal)
// ---------------------------------------------------------------------------

/**
 * Describes a single error that occurred during a pipeline stage.
 */
export interface PipelineError {
  stage: string;
  message: string;
  retryCount: number;
  fatal: boolean;
}

/**
 * Internal state object that tracks the current stage and partial results
 * of a single pipeline run.
 */
export interface PipelineState {
  /** UUID v4 run identifier */
  runId: string;
  topic: string;
  stage:
    | "init"
    | "discovery"
    | "sentinel"
    | "search"
    | "llm"
    | "image"
    | "persist"
    | "done"
    | "error";
  /** Unix timestamp (ms) when the run started */
  startedAt: number;
  /** Partial brief assembled incrementally as stages complete */
  results: Partial<ResearchBrief>;
  errors: PipelineError[];
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/**
 * Top-level runtime configuration for the BountyAgent, loaded from
 * environment variables via loadConfig().
 *
 * Requirements: 14.1–14.5
 */
export interface BountyAgentConfig {
  /** Solana mainnet RPC URL, e.g. "https://us-1-mainnet.oobeprotocol.ai/rpc?api_key=..." */
  solanaRpcUrl: string;
  /** Filesystem path to the Solana keypair JSON file */
  walletKeypairPath: string;
  /** AceDataCloud API base URL, defaults to "https://api.acedata.cloud" */
  aceDataCloudBaseUrl: string;
  /** x402 facilitator URL, defaults to "https://facilitator.acedata.cloud" */
  facilitatorUrl: string;
  /** Synapse Sentinel agent wallet address */
  sentinelWallet: string;
  /** USDC SPL token mint on Solana mainnet */
  usdcMint: string;
  /** x402 settlement network */
  network: "solana" | "base";
}

/**
 * Configuration passed to SapRegistrar.ensureRegistered() to create or
 * update the agent's on-chain identity.
 *
 * Requirements: 2.1, 2.2
 */
export interface AgentRegistrationConfig {
  name: string;
  description: string;
  capabilities: Capability[];
  /** SAP protocol identifiers, e.g. ["A2A", "MCP", "acedata"] */
  protocols: string[];
  /** The agent's own x402-capable HTTP endpoint */
  x402Endpoint: string;
}

// ---------------------------------------------------------------------------
// x402 payment context
// ---------------------------------------------------------------------------

/**
 * The opaque payment context returned by `client.x402.preparePayment()`.
 *
 * The exact shape is defined by the @oobe-protocol-labs/synapse-sap-sdk and
 * may change between SDK versions. We type it as `unknown` here and cast
 * where needed so that the rest of the codebase remains type-safe without
 * depending on internal SDK types.
 */
export type PaymentContext = unknown;
