/**
 * BountyAgent â€” top-level pipeline orchestrator.
 *
 * Responsibilities:
 *  - initialize(): load keypair, create SapClient, check balances, register on SAP
 *  - run(topic): execute the full research pipeline sequentially
 *  - shutdown(): close SAP client connection
 *
 * Requirements: 1.1â€“1.7, 2.5, 9.1â€“9.5, 11.1â€“11.6, 12.1â€“12.6, 13.1â€“13.3
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import { randomUUID } from "crypto";
// SapConnection is imported dynamically to avoid subpath resolution issues
// with moduleResolution: "bundler". The high-level client is typed as `any`
// following the same pattern as SapRegistrar, ToolDiscovery, and SentinelClient.
import { loadKeypair } from "../utils/keypair.js";
// retry.ts is used indirectly via withSelectiveRetry below
import {
  InsufficientSolError,
  InsufficientUsdcError,
  InsufficientFundsError,
  PaymentError,
  ContentValidationError,
  DuplicateRunError,
} from "../utils/errors.js";
import type {
  BountyAgentConfig,
  ResearchBrief,
  PipelineState,
  PipelineError,
  PaymentRecord,
  AgentRegistrationConfig,
} from "../types/index.js";
import { SapRegistrar } from "./SapRegistrar.js";
import { ToolDiscovery } from "./ToolDiscovery.js";
import { SentinelClient } from "./SentinelClient.js";
import { AceDataCloudClient } from "./AceDataCloudClient.js";
import { ResultPersister } from "./ResultPersister.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SOL_BALANCE = 0.015; // SOL (Requirement 13.1)
const MIN_USDC_BALANCE = 0.5; // USDC (Requirement 13.2)
const USDC_DECIMALS = 6;

const AGENT_REGISTRATION_CONFIG: AgentRegistrationConfig = {
  name: "ResearchBriefAgent",
  description:
    "Autonomous research pipeline: web search + LLM analysis + image generation, settled via x402",
  capabilities: [
    {
      id: "acedata:search",
      protocolId: "acedata",
      version: "1.0",
      description: "Web search via AceDataCloud",
    },
    {
      id: "acedata:llm",
      protocolId: "acedata",
      version: "1.0",
      description: "LLM chat via AceDataCloud",
    },
    {
      id: "acedata:image",
      protocolId: "acedata",
      version: "1.0",
      description: "Image generation via AceDataCloud",
    },
    {
      id: "data:oracle",
      protocolId: "pyth",
      version: "1.0",
      description: "Price oracle via Sentinel",
    },
  ],
  protocols: ["A2A", "MCP", "acedata"],
  x402Endpoint: "",
};

const RETRY_OPTS = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8000 };

// Errors that must NOT be retried (Requirement 12.3)
const NON_RETRYABLE = [
  InsufficientFundsError,
  PaymentError,
  ContentValidationError,
  InsufficientSolError,
  InsufficientUsdcError,
  DuplicateRunError,
];

function isRetryable(err: unknown): boolean {
  for (const cls of NON_RETRYABLE) {
    if (err instanceof cls) return false;
  }
  return true;
}

/**
 * Retry wrapper that skips retries for non-retryable errors.
 * Wraps withRetry but rethrows immediately for non-retryable error types.
 */
async function withSelectiveRetry<T>(
  fn: () => Promise<T>,
  opts: typeof RETRY_OPTS
): Promise<T> {
  // We implement our own retry loop here to support the isRetryable predicate
  const { maxAttempts, baseDelayMs, maxDelayMs } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Non-retryable errors are thrown immediately (Requirement 12.3)
      if (!isRetryable(err)) throw err;

      // No delay after the final attempt
      if (attempt < maxAttempts) {
        const baseDelay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1),
          maxDelayMs
        );
        const jitter = 0.8 + Math.random() * 0.4;
        const delay = Math.round(baseDelay * jitter);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// BountyAgent
// ---------------------------------------------------------------------------

export class BountyAgent {
  private initialized = false;
  private readonly runningTopics = new Set<string>();

  // Components â€” set during initialize()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sapClient: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private sapConnection: any = null;
  private sapRegistrar: SapRegistrar | null = null;
  private toolDiscovery: ToolDiscovery | null = null;
  private sentinelClient: SentinelClient | null = null;
  private aceClient: AceDataCloudClient | null = null;
  private resultPersister: ResultPersister | null = null;
  private agentPda: string = "";

  constructor(private readonly config: BountyAgentConfig) {}

  // -------------------------------------------------------------------------
  // initialize()
  // -------------------------------------------------------------------------

  /**
   * Load keypair, create SapClient, check balances, register on SAP.
   * Must be called before run().
   * Requirements: 1.1â€“1.7, 2.5, 13.1â€“13.3
   */
  async initialize(): Promise<void> {
    // Step 1: Load keypair (Requirement 1.1, 1.4, 1.5)
    const keypair = loadKeypair(this.config.walletKeypairPath);

    // Step 2: Create SapClient (Requirement 1.2)
    // Dynamic import to avoid subpath resolution issues with moduleResolution: "bundler"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { SapConnection } = await import("@oobe-protocol-labs/synapse-sap-sdk/dist/esm/core/connection.js" as any);
    const { client, connection: sapConn } = SapConnection.fromKeypair(
      this.config.solanaRpcUrl,
      keypair
    );
    this.sapClient = client;
    this.sapConnection = sapConn;

    // Step 3: Check SOL balance (Requirement 13.1)
    const solConnection = new Connection(this.config.solanaRpcUrl, "confirmed");
    const lamports = await solConnection.getBalance(keypair.publicKey);
    const solBalance = lamports / 1e9;
    if (solBalance < MIN_SOL_BALANCE) {
      throw new InsufficientSolError(solBalance, MIN_SOL_BALANCE);
    }

    // Step 4: Check USDC balance (Requirement 13.2, 13.3)
    const usdcMint = new PublicKey(this.config.usdcMint);
    let usdcBalance = 0;
    try {
      const ata = await getAssociatedTokenAddress(usdcMint, keypair.publicKey);
      const tokenAccount = await getAccount(solConnection, ata);
      usdcBalance =
        Number(tokenAccount.amount) / Math.pow(10, USDC_DECIMALS);
    } catch {
      // Token account may not exist â€” treat as 0 balance
      usdcBalance = 0;
    }
    if (usdcBalance < MIN_USDC_BALANCE) {
      throw new InsufficientUsdcError(usdcBalance, MIN_USDC_BALANCE);
    }

    // Step 5: Instantiate components (Requirement 1.3)
    this.sapRegistrar = new SapRegistrar(this.sapClient);
    this.toolDiscovery = new ToolDiscovery(this.sapClient);
    this.sentinelClient = new SentinelClient(this.sapClient);
    this.aceClient = new AceDataCloudClient(
      keypair,
      this.config.aceDataCloudBaseUrl,
      this.config.facilitatorUrl
    );

    // Step 6: Register on SAP (Requirement 2.5)
    const agentAccount = await this.sapRegistrar.ensureRegistered(
      AGENT_REGISTRATION_CONFIG
    );
    if (!agentAccount.isActive) {
      throw new Error(
        "[BountyAgent] SAP registration succeeded but isActive is false"
      );
    }

    // Step 7: Derive agent PDA for ResultPersister
    try {
      const [pdaKey] = this.sapClient.agent.deriveAgent() as [
        { toBase58(): string },
        number
      ];
      this.agentPda = pdaKey.toBase58();
    } catch {
      this.agentPda = keypair.publicKey.toBase58();
    }

    this.resultPersister = new ResultPersister(this.sapClient, this.agentPda);

    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // run(topic)
  // -------------------------------------------------------------------------

  /**
   * Execute the full research pipeline for the given topic.
   * Requirements: 9.1â€“9.5, 11.1â€“11.6, 12.1â€“12.5
   */
  async run(topic: string): Promise<ResearchBrief> {
    // Guard: must be initialized (Requirement 11.6)
    if (!this.initialized) {
      throw new Error(
        "[BountyAgent] Agent not initialized. Call initialize() before run()."
      );
    }

    // Guard: no duplicate concurrent runs (Requirement 9.2)
    if (this.runningTopics.has(topic)) {
      throw new DuplicateRunError(topic);
    }
    this.runningTopics.add(topic);

    // Initialize pipeline state (Requirement 11.4)
    const state: PipelineState & {
      results: Partial<ResearchBrief> & { discovery?: unknown; sentinelResult?: { price: number; asset: string; settlementTx: string } };
    } = {
      runId: randomUUID(),
      topic,
      stage: "init",
      startedAt: Date.now(),
      results: {
        id: randomUUID(),
        topic,
        createdAt: Math.floor(Date.now() / 1000),
        payments: [],
      },
      errors: [],
    };

    try {
      // â”€â”€ Stage: discovery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "discovery";
      await withSelectiveRetry(
        async () => {
          const sentinel = await this.toolDiscovery!.findSentinel();
          state.results.discovery = sentinel;
        },
        RETRY_OPTS
      );

      // â”€â”€ Stage: sentinel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "sentinel";
      await withSelectiveRetry(
        async () => {
          const priceResult = await this.sentinelClient!.getPythPrice("SOL/USD");
          state.results.solPrice = priceResult.price;
          state.results.sentinelResult = priceResult;

          const payment: PaymentRecord = {
            service: "sentinel",
            network: "solana",
            amountUsdc: "0.02",
            txHash: priceResult.settlementTx,
            settledAt: Math.floor(Date.now() / 1000),
          };
          (state.results.payments as PaymentRecord[]).push(payment);
        },
        RETRY_OPTS
      );

      // â”€â”€ Stage: search â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "search";
      await withSelectiveRetry(
        async () => {
          const searchResults = await this.aceClient!.search(topic);
          state.results.searchResults = searchResults;

          const txHash = this.aceClient!.getLastX402Tx();
          const payment: PaymentRecord = {
            service: "acedata-search",
            network: "solana",
            amountUsdc: "0.095215",
            txHash,
            settledAt: Math.floor(Date.now() / 1000),
          };
          (state.results.payments as PaymentRecord[]).push(payment);
        },
        RETRY_OPTS
      );

      // â”€â”€ Stage: llm â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "llm";
      await withSelectiveRetry(
        async () => {
          const prompt = buildAnalysisPrompt(
            topic,
            state.results.searchResults ?? [],
            state.results.sentinelResult
          );
          const analysis = await this.aceClient!.chat(
            [{ role: "user", content: prompt }],
            "gpt-4o-mini"
          );
          state.results.analysis = analysis;

          const txHash = this.aceClient!.getLastX402Tx();
          const payment: PaymentRecord = {
            service: "acedata-llm",
            network: "solana",
            amountUsdc: "0.095215",
            txHash,
            settledAt: Math.floor(Date.now() / 1000),
          };
          (state.results.payments as PaymentRecord[]).push(payment);
        },
        RETRY_OPTS
      );

      // â”€â”€ Stage: image â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "image";
      await withSelectiveRetry(
        async () => {
          const imagePrompt = buildImagePrompt(
            topic,
            state.results.analysis ?? ""
          );
          const imageResult = await this.aceClient!.generateImage(imagePrompt);
          state.results.imageUrl = imageResult.imageUrl;

          const payment: PaymentRecord = {
            service: "acedata-image",
            network: "solana",
            amountUsdc: "0.095215",
            txHash: imageResult.paymentTxHash,
            settledAt: Math.floor(Date.now() / 1000),
          };
          (state.results.payments as PaymentRecord[]).push(payment);
        },
        RETRY_OPTS
      );

      // â”€â”€ Stage: persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      state.stage = "persist";
      const brief = assembleBrief(state);

      const ledgerEntry = await withSelectiveRetry(
        () => this.resultPersister!.persist(brief),
        RETRY_OPTS
      );

      brief.onChain = {
        ledgerTx: ledgerEntry.tx,
        contentHash: ledgerEntry.contentHash,
        agentPda: ledgerEntry.agentPda,
      };

      state.stage = "done";

      // Log success output (Requirement 11.3)
      console.log(`\n[BountyAgent] Pipeline complete for topic: "${topic}"`);
      console.log(`  SOL Price:    $${brief.solPrice}`);
      console.log(`  Analysis:     ${brief.analysis.slice(0, 200)}...`);
      console.log(`  Image URL:    ${brief.imageUrl}`);
      console.log(`  Payments (${brief.payments.length}):`);
      for (const p of brief.payments) {
        console.log(`    [${p.service}] ${p.amountUsdc} USDC â€” tx: ${p.txHash}`);
      }
      console.log(`  Ledger TX:    ${brief.onChain.ledgerTx}`);
      console.log(`  Content Hash: ${brief.onChain.contentHash}`);

      return brief;
    } catch (err) {
      // Fatal error handling (Requirement 12.2, 12.5)
      state.stage = "error";
      const pipelineError: PipelineError = {
        stage: state.stage,
        message: err instanceof Error ? err.message : String(err),
        retryCount: 0,
        fatal: true,
      };
      state.errors.push(pipelineError);
      throw err;
    } finally {
      // Always remove topic from running set (Requirement 9.2)
      this.runningTopics.delete(topic);
    }
  }

  // -------------------------------------------------------------------------
  // shutdown()
  // -------------------------------------------------------------------------

  /**
   * Close SAP client connection and release held resources.
   * Requirements: 12.6
   */
  async shutdown(): Promise<void> {
    try {
      if (this.sapClient && typeof this.sapClient.close === "function") {
        await this.sapClient.close();
      }
    } catch {
      // Best-effort cleanup
    }
    this.initialized = false;
  }
}

// ---------------------------------------------------------------------------
// assembleBrief()
// ---------------------------------------------------------------------------

/**
 * Assemble a ResearchBrief from the pipeline state.
 * Validates all required fields are present.
 * Requirements: 9.1, 9.3, 9.4, 9.5, 15.1, 15.2
 */
export function assembleBrief(state: PipelineState): ResearchBrief {
  const r = state.results;

  // Validate required fields (Requirement 9.5)
  const missing: string[] = [];
  if (!r.id) missing.push("id");
  if (!r.topic) missing.push("topic");
  if (r.createdAt === undefined || r.createdAt === null) missing.push("createdAt");
  if (r.solPrice === undefined || r.solPrice === null || r.solPrice <= 0)
    missing.push("solPrice");
  if (!r.searchResults || r.searchResults.length === 0)
    missing.push("searchResults");
  if (!r.analysis) missing.push("analysis");
  if (!r.imageUrl) missing.push("imageUrl");
  if (!r.payments || (r.payments as PaymentRecord[]).length < 4)
    missing.push("payments (need 4)");

  if (missing.length > 0) {
    throw new Error(
      `[BountyAgent] Cannot assemble ResearchBrief â€” missing required fields: ${missing.join(", ")}`
    );
  }

  const payments = (r.payments as PaymentRecord[]).map((p) => ({
    ...p,
    network: "solana" as const, // Requirement 9.3
    settledAt: p.settledAt ?? Math.floor(Date.now() / 1000), // Requirement 9.4
  }));

  return {
    id: r.id!,
    topic: r.topic!,
    createdAt: r.createdAt!,
    solPrice: r.solPrice!,
    searchResults: r.searchResults!,
    analysis: r.analysis!,
    imageUrl: r.imageUrl!,
    payments,
    onChain: {
      ledgerTx: "",
      contentHash: "",
      agentPda: "",
    },
  };
}

// ---------------------------------------------------------------------------
// buildAnalysisPrompt()
// ---------------------------------------------------------------------------

/**
 * Build the LLM analysis prompt from topic, search results, and SOL price.
 * Requirements: 6.1, 11.1
 */
export function buildAnalysisPrompt(
  topic: string,
  searchResults: Array<{ title: string; url: string; snippet: string }>,
  priceResult?: { price: number; asset: string }
): string {
  // Sanitise topic: strip control characters, truncate to 500 chars (Requirement 11.2)
  // eslint-disable-next-line no-control-regex
  const sanitisedTopic = topic.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 500);

  const snippets = searchResults
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`)
    .join("\n\n");

  const priceContext = priceResult
    ? `\nCurrent SOL/USD price: $${priceResult.price} (from Pyth oracle via Synapse Sentinel)`
    : "";

  return `You are a professional research analyst. Synthesise the following web search results into a structured analysis of the topic: "${sanitisedTopic}".${priceContext}

Search Results:
${snippets}

Provide a comprehensive analysis covering:
1. Key findings and trends
2. Market implications
3. Notable developments
4. Forward-looking insights

Write at least 200 words. Be specific and data-driven.`;
}

// ---------------------------------------------------------------------------
// buildImagePrompt()
// ---------------------------------------------------------------------------

/**
 * Build a Midjourney-style image prompt from topic and analysis.
 * Requirements: 7.6, 11.3
 */
export function buildImagePrompt(topic: string, analysis: string): string {
  // Derive a concise visual concept from the topic
  // eslint-disable-next-line no-control-regex
  const sanitisedTopic = topic.replace(/[\x00-\x1F\x7F]/g, "").slice(0, 100);

  // Extract key themes from the first sentence of the analysis
  const firstSentence = analysis.split(/[.!?]/)[0]?.trim() ?? "";
  const themeHint = firstSentence.slice(0, 80);

  return `Professional digital illustration of ${sanitisedTopic}, ${themeHint}, futuristic blockchain technology, Solana ecosystem, vibrant blue and purple tones, high detail, 4K, cinematic lighting --ar 16:9 --style raw`;
}

