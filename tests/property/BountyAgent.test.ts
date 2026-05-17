/**
 * Property-based tests for BountyAgent in src/agent/BountyAgent.ts
 *
 * **Property 19: No Further Transactions After Fatal Error** — for any fatal
 * error in any pipeline stage, no subsequent on-chain transactions (ledger
 * append, escrow settlement) are submitted.
 *
 * **Property 20: SOL Balance Pre-flight** — for any wallet with SOL balance
 * < 0.015 SOL, initialize() throws InsufficientSolError before any on-chain
 * call; for balance ≥ 0.015 SOL, no SOL balance error is thrown.
 *
 * **Validates: Requirements 12.2, 12.5, 13.1**
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Module-level mocks — must be hoisted before any imports of the mocked modules
// ---------------------------------------------------------------------------

vi.mock(
  "@oobe-protocol-labs/synapse-sap-sdk/dist/esm/core/connection.js",
  () => ({
    SapConnection: {
      fromKeypair: vi.fn().mockReturnValue({
        client: {
          agent: {
            deriveAgent: vi.fn().mockReturnValue([{ toBase58: () => "mock-pda" }, 255]),
          },
          ledger: { append: vi.fn().mockResolvedValue("mock-ledger-tx") },
          x402: {},
          discovery: {},
          indexing: {},
          tools: {},
          close: vi.fn().mockResolvedValue(undefined),
        },
        connection: {},
      }),
    },
  })
);

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(1_000_000_000), // 1 SOL — sufficient by default
    })),
  };
});

vi.mock("@solana/spl-token", () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue("mock-ata"),
  getAccount: vi.fn().mockResolvedValue({ amount: BigInt(1_000_000) }), // 1 USDC
}));

vi.mock("../../src/utils/keypair.js", () => ({
  loadKeypair: vi.fn().mockReturnValue({
    publicKey: { toBase58: () => "mock-pubkey", toBuffer: () => Buffer.alloc(32) },
    secretKey: new Uint8Array(64),
  }),
}));

// Mock all sub-components so initialize() never makes live calls
vi.mock("../../src/agent/SapRegistrar.js", () => ({
  SapRegistrar: vi.fn().mockImplementation(() => ({
    ensureRegistered: vi.fn().mockResolvedValue({ isActive: true }),
    fetchProfile: vi.fn().mockResolvedValue({}),
    publishToolSchemas: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../src/agent/ToolDiscovery.js", () => ({
  ToolDiscovery: vi.fn().mockImplementation(() => ({
    findSentinel: vi.fn().mockResolvedValue({
      wallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
      isActive: true,
      hasX402: true,
    }),
    findAgentsByCapability: vi.fn().mockResolvedValue([]),
    verifyAgentActive: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock("../../src/agent/SentinelClient.js", () => ({
  SentinelClient: vi.fn().mockImplementation(() => ({
    getPythPrice: vi.fn().mockResolvedValue({
      asset: "SOL/USD",
      price: 185.42,
      confidence: 0.01,
      timestamp: Date.now(),
      settlementTx: "mock-sentinel-tx",
    }),
  })),
}));

vi.mock("../../src/agent/AceDataCloudClient.js", () => ({
  AceDataCloudClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([
      { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" },
    ]),
    chat: vi.fn().mockResolvedValue(
      "This is a detailed analysis of the topic with more than fifty characters of content."
    ),
    generateImage: vi.fn().mockResolvedValue({
      imageUrl: "https://cdn.midjourney.com/test.png",
      taskId: "task-123",
      paymentTxHash: "mock-image-tx",
    }),
    getLastX402Tx: vi.fn().mockReturnValue("mock-x402-tx"),
    resetLastX402Tx: vi.fn(),
  })),
}));

vi.mock("../../src/agent/ResultPersister.js", () => ({
  ResultPersister: vi.fn().mockImplementation(() => ({
    persist: vi.fn().mockResolvedValue({
      tx: "mock-ledger-tx",
      contentHash: "mock-hash",
      agentPda: "mock-pda",
    }),
    fetchHistory: vi.fn().mockResolvedValue([]),
  })),
}));

// ---------------------------------------------------------------------------
// Import BountyAgent AFTER mocks are set up
// ---------------------------------------------------------------------------
import { BountyAgent, assembleBrief } from "../../src/agent/BountyAgent.js";
import { PaymentError, InsufficientSolError, InsufficientUsdcError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = {
  solanaRpcUrl: "https://mock-rpc.example.com",
  walletKeypairPath: "./mock-wallet.json",
  aceDataCloudBaseUrl: "https://api.acedata.cloud",
  facilitatorUrl: "https://facilitator.acedata.cloud",
  sentinelWallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  network: "solana" as const,
};

/**
 * Build a mock ResultPersister spy.
 */
function buildMockResultPersister() {
  return {
    persist: vi.fn().mockResolvedValue({
      tx: "mock-ledger-tx",
      contentHash: "mock-hash",
      agentPda: "mock-pda",
    }),
    fetchHistory: vi.fn().mockResolvedValue([]),
  };
}

/**
 * Create a pre-initialized BountyAgent with all sub-components replaced by
 * mocks injected directly into private fields. This bypasses initialize()
 * entirely so no live RPC calls or retry delays are involved.
 */
function buildInitializedAgent() {
  const agent = new BountyAgent(BASE_CONFIG);

  const sapClient = {
    agent: {
      fetch: vi.fn().mockResolvedValue({ isActive: true }),
      register: vi.fn().mockResolvedValue("tx-register"),
      deriveAgent: vi.fn().mockReturnValue([{ toBase58: () => "mock-pda" }, 255]),
    },
    x402: {
      preparePayment: vi.fn().mockResolvedValue({ __ctx: true }),
      buildPaymentHeaders: vi.fn().mockReturnValue({ "X-SAP-Payment": "mock" }),
    },
    ledger: {
      append: vi.fn().mockResolvedValue("mock-ledger-tx"),
    },
    discovery: {
      findAgentsByCapability: vi.fn().mockResolvedValue([]),
    },
    close: vi.fn().mockResolvedValue(undefined),
  };

  const sapRegistrar = {
    ensureRegistered: vi.fn().mockResolvedValue({ isActive: true }),
    fetchProfile: vi.fn().mockResolvedValue({}),
    publishToolSchemas: vi.fn().mockResolvedValue(undefined),
  };

  const toolDiscovery = {
    findSentinel: vi.fn().mockResolvedValue({
      wallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
      isActive: true,
      hasX402: true,
    }),
    findAgentsByCapability: vi.fn().mockResolvedValue([]),
    verifyAgentActive: vi.fn().mockResolvedValue(true),
  };

  const sentinelClient = {
    getPythPrice: vi.fn().mockResolvedValue({
      asset: "SOL/USD",
      price: 185.42,
      confidence: 0.01,
      timestamp: Date.now(),
      settlementTx: "mock-sentinel-tx",
    }),
  };

  const aceClient = {
    search: vi.fn().mockResolvedValue([
      { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" },
    ]),
    chat: vi.fn().mockResolvedValue(
      "This is a detailed analysis of the topic with more than fifty characters of content."
    ),
    generateImage: vi.fn().mockResolvedValue({
      imageUrl: "https://cdn.midjourney.com/test.png",
      taskId: "task-123",
      paymentTxHash: "mock-image-tx",
    }),
    getLastX402Tx: vi.fn().mockReturnValue("mock-x402-tx"),
    resetLastX402Tx: vi.fn(),
  };

  const resultPersister = buildMockResultPersister();

  // Inject mocks directly into private fields — bypasses initialize()
  Object.assign(agent, {
    initialized: true,
    sapClient,
    sapConnection: {},
    sapRegistrar,
    toolDiscovery,
    sentinelClient,
    aceClient,
    resultPersister,
    agentPda: "mock-pda",
  });

  return { agent, sapClient, sapRegistrar, toolDiscovery, sentinelClient, aceClient, resultPersister };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Pipeline stages that can fail before the "persist" stage.
 * We use PaymentError (a non-retryable error type) so withSelectiveRetry
 * throws immediately without waiting for backoff delays.
 */
const failingStageArb = fc.constantFrom(
  "discovery",
  "sentinel",
  "search",
  "llm",
  "image"
);

const topicArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

// ---------------------------------------------------------------------------
// Property 19: No Further Transactions After Fatal Error
// ---------------------------------------------------------------------------

describe("BountyAgent Properties", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("Property 19: No Further Transactions After Fatal Error", () => {
    it(
      "**Validates: Requirements 12.2, 12.5** — for any fatal error in any pipeline stage, resultPersister.persist() is NEVER called",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            failingStageArb,
            topicArb,
            async (failingStage: string, topic: string) => {
              const { agent, toolDiscovery, sentinelClient, aceClient, resultPersister } =
                buildInitializedAgent();

              // Use PaymentError — a non-retryable error — so withSelectiveRetry
              // throws immediately without any backoff delay.
              const fatalError = new PaymentError(
                `Fatal error in stage: ${failingStage}`
              );

              switch (failingStage) {
                case "discovery":
                  toolDiscovery.findSentinel.mockRejectedValue(fatalError);
                  break;
                case "sentinel":
                  sentinelClient.getPythPrice.mockRejectedValue(fatalError);
                  break;
                case "search":
                  aceClient.search.mockRejectedValue(fatalError);
                  break;
                case "llm":
                  aceClient.chat.mockRejectedValue(fatalError);
                  break;
                case "image":
                  aceClient.generateImage.mockRejectedValue(fatalError);
                  break;
              }

              await expect(agent.run(topic)).rejects.toThrow();

              // persist() must NEVER be called after a fatal error
              expect(resultPersister.persist).not.toHaveBeenCalled();
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      "**Validates: Requirements 12.2, 12.5** — for any fatal error in any pipeline stage, no further SAP/escrow transactions are submitted after the error",
      async () => {
        await fc.assert(
          fc.asyncProperty(
            failingStageArb,
            topicArb,
            async (failingStage: string, topic: string) => {
              const { agent, sapClient, toolDiscovery, sentinelClient, aceClient, resultPersister } =
                buildInitializedAgent();

              const fatalError = new PaymentError(
                `Fatal error in stage: ${failingStage}`
              );

              switch (failingStage) {
                case "discovery":
                  toolDiscovery.findSentinel.mockRejectedValue(fatalError);
                  break;
                case "sentinel":
                  sentinelClient.getPythPrice.mockRejectedValue(fatalError);
                  break;
                case "search":
                  aceClient.search.mockRejectedValue(fatalError);
                  break;
                case "llm":
                  aceClient.chat.mockRejectedValue(fatalError);
                  break;
                case "image":
                  aceClient.generateImage.mockRejectedValue(fatalError);
                  break;
              }

              await expect(agent.run(topic)).rejects.toThrow();

              // No on-chain ledger append after fatal error
              expect(sapClient.ledger.append).not.toHaveBeenCalled();
              expect(resultPersister.persist).not.toHaveBeenCalled();
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      "**Validates: Requirements 12.2** — fatal error in discovery stage prevents ALL subsequent stage calls",
      async () => {
        await fc.assert(
          fc.asyncProperty(topicArb, async (topic: string) => {
            const { agent, toolDiscovery, sentinelClient, aceClient, resultPersister } =
              buildInitializedAgent();

            toolDiscovery.findSentinel.mockRejectedValue(
              new PaymentError("Fatal: discovery failed")
            );

            await expect(agent.run(topic)).rejects.toThrow();

            expect(sentinelClient.getPythPrice).not.toHaveBeenCalled();
            expect(aceClient.search).not.toHaveBeenCalled();
            expect(aceClient.chat).not.toHaveBeenCalled();
            expect(aceClient.generateImage).not.toHaveBeenCalled();
            expect(resultPersister.persist).not.toHaveBeenCalled();
          }),
          { numRuns: 5 }
        );
      }
    );

    it(
      "**Validates: Requirements 12.5** — fatal error in image stage prevents persist but allows prior stages to have completed",
      async () => {
        await fc.assert(
          fc.asyncProperty(topicArb, async (topic: string) => {
            const { agent, aceClient, resultPersister } = buildInitializedAgent();

            aceClient.generateImage.mockRejectedValue(
              new PaymentError("Fatal: image generation failed")
            );

            await expect(agent.run(topic)).rejects.toThrow();

            expect(resultPersister.persist).not.toHaveBeenCalled();
          }),
          { numRuns: 5 }
        );
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 20: SOL Balance Pre-flight
// ---------------------------------------------------------------------------

const MIN_SOL_LAMPORTS_THRESHOLD = 15_000_000; // 0.015 SOL
const MIN_USDC_MICRO_THRESHOLD = 500_000; // 0.50 USDC (6 decimals)

describe("Property 20: SOL Balance Pre-flight", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "**Validates: Requirements 13.1** — initialize() throws InsufficientSolError for any SOL balance < 0.015 SOL",
    async () => {
      const { Connection } = await import("@solana/web3.js");

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: MIN_SOL_LAMPORTS_THRESHOLD - 1 }),
          async (lamports: number) => {
            (Connection as ReturnType<typeof vi.fn>).mockImplementation(() => ({
              getBalance: vi.fn().mockResolvedValue(lamports),
            }));

            const agent = new BountyAgent(BASE_CONFIG);

            let thrownError: unknown;
            try {
              await agent.initialize();
            } catch (e) {
              thrownError = e;
            }

            expect(thrownError).toBeInstanceOf(InsufficientSolError);
            expect((thrownError as InsufficientSolError).code).toBe("INSUFFICIENT_SOL");

            const solBalance = lamports / 1e9;
            expect((thrownError as InsufficientSolError).message).toContain(
              solBalance.toFixed(6)
            );
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    "**Validates: Requirements 13.1** — initialize() does NOT throw InsufficientSolError for any SOL balance ≥ 0.015 SOL",
    async () => {
      const { Connection } = await import("@solana/web3.js");

      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: MIN_SOL_LAMPORTS_THRESHOLD, max: 100_000_000 }),
          async (lamports: number) => {
            (Connection as ReturnType<typeof vi.fn>).mockImplementation(() => ({
              getBalance: vi.fn().mockResolvedValue(lamports),
            }));

            const agent = new BountyAgent(BASE_CONFIG);

            let thrownError: unknown;
            try {
              await agent.initialize();
            } catch (e) {
              thrownError = e;
            }

            // Must NOT throw InsufficientSolError — any other error (e.g. USDC
            // balance check, SAP registration) is acceptable in this property.
            expect(thrownError).not.toBeInstanceOf(InsufficientSolError);
          }
        ),
        { numRuns: 5 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 17: Pipeline Stage Sequence Enforcement
// ---------------------------------------------------------------------------

/**
 * Canonical stage order for a successful pipeline run.
 * Each entry maps to the component method called at that stage.
 */
const CANONICAL_STAGES = [
  "discovery",
  "sentinel",
  "search",
  "llm",
  "image",
  "persist",
] as const;

type CanonicalStage = (typeof CANONICAL_STAGES)[number];

/**
 * Returns the index of a stage in the canonical order, or -1 if not found.
 */
function canonicalIndex(stage: CanonicalStage): number {
  return CANONICAL_STAGES.indexOf(stage);
}

describe("Property 17: Pipeline Stage Sequence Enforcement", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "**Validates: Requirements 11.4** — Test 1 (Happy path): for any valid topic, a successful run visits stages in exact canonical order: discovery → sentinel → search → llm → image → persist",
    async () => {
      await fc.assert(
        fc.asyncProperty(topicArb, async (topic: string) => {
          const { agent, toolDiscovery, sentinelClient, aceClient, resultPersister } =
            buildInitializedAgent();

          // Track the order in which component methods are called
          const callOrder: CanonicalStage[] = [];

          toolDiscovery.findSentinel.mockImplementation(async () => {
            callOrder.push("discovery");
            return {
              wallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
              isActive: true,
              hasX402: true,
            };
          });

          sentinelClient.getPythPrice.mockImplementation(async () => {
            callOrder.push("sentinel");
            return {
              asset: "SOL/USD",
              price: 185.42,
              confidence: 0.01,
              timestamp: Date.now(),
              settlementTx: "mock-sentinel-tx",
            };
          });

          aceClient.search.mockImplementation(async () => {
            callOrder.push("search");
            return [{ title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" }];
          });

          aceClient.chat.mockImplementation(async () => {
            callOrder.push("llm");
            return "This is a detailed analysis of the topic with more than fifty characters of content.";
          });

          aceClient.generateImage.mockImplementation(async () => {
            callOrder.push("image");
            return {
              imageUrl: "https://cdn.midjourney.com/test.png",
              taskId: "task-123",
              paymentTxHash: "mock-image-tx",
            };
          });

          resultPersister.persist.mockImplementation(async () => {
            callOrder.push("persist");
            return {
              tx: "mock-ledger-tx",
              contentHash: "mock-hash",
              agentPda: "mock-pda",
            };
          });

          await agent.run(topic);

          // All 6 stages must be visited in exact canonical order
          expect(callOrder).toEqual([...CANONICAL_STAGES]);
        }),
        { numRuns: 10 }
      );
    }
  );

  it(
    "**Validates: Requirements 11.4** — Test 2 (Failure at each stage): stages visited before a failure are a strict prefix of the canonical order; no stage after the failure point is visited",
    async () => {
      // Map each failing stage to the index in CANONICAL_STAGES where it fails
      const stageFailureArb = fc.constantFrom(
        "discovery" as CanonicalStage,
        "sentinel" as CanonicalStage,
        "search" as CanonicalStage,
        "llm" as CanonicalStage,
        "image" as CanonicalStage
      );

      await fc.assert(
        fc.asyncProperty(
          stageFailureArb,
          topicArb,
          async (failingStage: CanonicalStage, topic: string) => {
            const { agent, toolDiscovery, sentinelClient, aceClient, resultPersister } =
              buildInitializedAgent();

            const callOrder: CanonicalStage[] = [];
            const fatalError = new PaymentError(`Fatal error at stage: ${failingStage}`);

            // Wire up each mock to either record the call or throw
            toolDiscovery.findSentinel.mockImplementation(async () => {
              if (failingStage === "discovery") throw fatalError;
              callOrder.push("discovery");
              return {
                wallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
                isActive: true,
                hasX402: true,
              };
            });

            sentinelClient.getPythPrice.mockImplementation(async () => {
              if (failingStage === "sentinel") throw fatalError;
              callOrder.push("sentinel");
              return {
                asset: "SOL/USD",
                price: 185.42,
                confidence: 0.01,
                timestamp: Date.now(),
                settlementTx: "mock-sentinel-tx",
              };
            });

            aceClient.search.mockImplementation(async () => {
              if (failingStage === "search") throw fatalError;
              callOrder.push("search");
              return [{ title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" }];
            });

            aceClient.chat.mockImplementation(async () => {
              if (failingStage === "llm") throw fatalError;
              callOrder.push("llm");
              return "This is a detailed analysis of the topic with more than fifty characters of content.";
            });

            aceClient.generateImage.mockImplementation(async () => {
              if (failingStage === "image") throw fatalError;
              callOrder.push("image");
              return {
                imageUrl: "https://cdn.midjourney.com/test.png",
                taskId: "task-123",
                paymentTxHash: "mock-image-tx",
              };
            });

            resultPersister.persist.mockImplementation(async () => {
              callOrder.push("persist");
              return {
                tx: "mock-ledger-tx",
                contentHash: "mock-hash",
                agentPda: "mock-pda",
              };
            });

            await expect(agent.run(topic)).rejects.toThrow();

            // The stages visited must be a strict prefix of the canonical order
            // ending just before the failing stage
            const failIdx = canonicalIndex(failingStage);
            const expectedPrefix = CANONICAL_STAGES.slice(0, failIdx);

            expect(callOrder).toEqual([...expectedPrefix]);

            // No stage at or after the failure point should have been visited
            for (const stage of CANONICAL_STAGES.slice(failIdx)) {
              expect(callOrder).not.toContain(stage);
            }
          }
        ),
        { numRuns: 10 }
      );
    }
  );

  it(
    "**Validates: Requirements 11.4** — Test 3 (No stage reversals): for any run (success or failure), the recorded stage sequence is a monotonically increasing subsequence of the canonical order",
    async () => {
      const runScenarioArb = fc.oneof(
        // Scenario A: successful run
        fc.record({ kind: fc.constant("success" as const), topic: topicArb }),
        // Scenario B: failure at a random stage
        fc.record({
          kind: fc.constant("failure" as const),
          topic: topicArb,
          failingStage: fc.constantFrom(
            "discovery" as CanonicalStage,
            "sentinel" as CanonicalStage,
            "search" as CanonicalStage,
            "llm" as CanonicalStage,
            "image" as CanonicalStage
          ),
        })
      );

      await fc.assert(
        fc.asyncProperty(runScenarioArb, async (scenario) => {
          const { agent, toolDiscovery, sentinelClient, aceClient, resultPersister } =
            buildInitializedAgent();

          const callOrder: CanonicalStage[] = [];
          const failingStage = scenario.kind === "failure" ? scenario.failingStage : null;
          const fatalError = failingStage
            ? new PaymentError(`Fatal error at stage: ${failingStage}`)
            : null;

          toolDiscovery.findSentinel.mockImplementation(async () => {
            if (failingStage === "discovery") throw fatalError!;
            callOrder.push("discovery");
            return {
              wallet: "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph",
              isActive: true,
              hasX402: true,
            };
          });

          sentinelClient.getPythPrice.mockImplementation(async () => {
            if (failingStage === "sentinel") throw fatalError!;
            callOrder.push("sentinel");
            return {
              asset: "SOL/USD",
              price: 185.42,
              confidence: 0.01,
              timestamp: Date.now(),
              settlementTx: "mock-sentinel-tx",
            };
          });

          aceClient.search.mockImplementation(async () => {
            if (failingStage === "search") throw fatalError!;
            callOrder.push("search");
            return [{ title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1" }];
          });

          aceClient.chat.mockImplementation(async () => {
            if (failingStage === "llm") throw fatalError!;
            callOrder.push("llm");
            return "This is a detailed analysis of the topic with more than fifty characters of content.";
          });

          aceClient.generateImage.mockImplementation(async () => {
            if (failingStage === "image") throw fatalError!;
            callOrder.push("image");
            return {
              imageUrl: "https://cdn.midjourney.com/test.png",
              taskId: "task-123",
              paymentTxHash: "mock-image-tx",
            };
          });

          resultPersister.persist.mockImplementation(async () => {
            callOrder.push("persist");
            return {
              tx: "mock-ledger-tx",
              contentHash: "mock-hash",
              agentPda: "mock-pda",
            };
          });

          if (scenario.kind === "success") {
            await agent.run(scenario.topic);
          } else {
            await expect(agent.run(scenario.topic)).rejects.toThrow();
          }

          // Verify the call order is a monotonically increasing subsequence
          // of the canonical order (no reversals, no duplicates)
          let lastCanonicalIdx = -1;
          for (const stage of callOrder) {
            const idx = canonicalIndex(stage);
            // Each stage must appear strictly after the previous one in canonical order
            expect(idx).toBeGreaterThan(lastCanonicalIdx);
            lastCanonicalIdx = idx;
          }
        }),
        { numRuns: 10 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 21: USDC Balance Pre-flight
// ---------------------------------------------------------------------------

describe("Property 21: USDC Balance Pre-flight", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "**Validates: Requirements 13.2** — initialize() throws InsufficientUsdcError for any USDC balance < 0.50 USDC",
    async () => {
      const { Connection } = await import("@solana/web3.js");
      const splToken = await import("@solana/spl-token");

      await fc.assert(
        fc.asyncProperty(
          // Generate micro-USDC amounts strictly below the 500_000 threshold
          fc.integer({ min: 0, max: MIN_USDC_MICRO_THRESHOLD - 1 }),
          async (microUsdc: number) => {
            // SOL balance must be sufficient so the SOL check passes
            (Connection as ReturnType<typeof vi.fn>).mockImplementation(() => ({
              getBalance: vi.fn().mockResolvedValue(MIN_SOL_LAMPORTS_THRESHOLD),
            }));

            // Mock USDC token account to return the generated balance
            (splToken.getAssociatedTokenAddress as ReturnType<typeof vi.fn>).mockResolvedValue(
              "mock-ata"
            );
            (splToken.getAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
              amount: BigInt(microUsdc),
            });

            const agent = new BountyAgent(BASE_CONFIG);

            let thrownError: unknown;
            try {
              await agent.initialize();
            } catch (e) {
              thrownError = e;
            }

            expect(thrownError).toBeInstanceOf(InsufficientUsdcError);
            expect((thrownError as InsufficientUsdcError).code).toBe("INSUFFICIENT_USDC");

            const usdcBalance = microUsdc / 1_000_000;
            expect((thrownError as InsufficientUsdcError).message).toContain(
              usdcBalance.toFixed(6)
            );
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    "**Validates: Requirements 13.2** — initialize() does NOT throw InsufficientUsdcError for any USDC balance ≥ 0.50 USDC",
    async () => {
      const { Connection } = await import("@solana/web3.js");
      const splToken = await import("@solana/spl-token");

      await fc.assert(
        fc.asyncProperty(
          // Generate micro-USDC amounts at or above the 500_000 threshold
          fc.integer({ min: MIN_USDC_MICRO_THRESHOLD, max: 10_000_000 }),
          async (microUsdc: number) => {
            // SOL balance must be sufficient so the SOL check passes
            (Connection as ReturnType<typeof vi.fn>).mockImplementation(() => ({
              getBalance: vi.fn().mockResolvedValue(MIN_SOL_LAMPORTS_THRESHOLD),
            }));

            // Mock USDC token account to return the generated balance
            (splToken.getAssociatedTokenAddress as ReturnType<typeof vi.fn>).mockResolvedValue(
              "mock-ata"
            );
            (splToken.getAccount as ReturnType<typeof vi.fn>).mockResolvedValue({
              amount: BigInt(microUsdc),
            });

            const agent = new BountyAgent(BASE_CONFIG);

            let thrownError: unknown;
            try {
              await agent.initialize();
            } catch (e) {
              thrownError = e;
            }

            // Must NOT throw InsufficientUsdcError — any other error (e.g. SAP
            // registration, keypair loading) is acceptable in this property.
            expect(thrownError).not.toBeInstanceOf(InsufficientUsdcError);
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    "**Validates: Requirements 13.2** — initialize() throws InsufficientUsdcError when USDC token account does not exist (treated as 0 balance)",
    async () => {
      const { Connection } = await import("@solana/web3.js");
      const splToken = await import("@solana/spl-token");

      // SOL balance must be sufficient so the SOL check passes
      (Connection as ReturnType<typeof vi.fn>).mockImplementation(() => ({
        getBalance: vi.fn().mockResolvedValue(MIN_SOL_LAMPORTS_THRESHOLD),
      }));

      // Simulate missing token account — getAccount throws
      (splToken.getAssociatedTokenAddress as ReturnType<typeof vi.fn>).mockResolvedValue(
        "mock-ata"
      );
      (splToken.getAccount as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("TokenAccountNotFoundError")
      );

      const agent = new BountyAgent(BASE_CONFIG);

      let thrownError: unknown;
      try {
        await agent.initialize();
      } catch (e) {
        thrownError = e;
      }

      // A missing token account is treated as 0 USDC, which is below threshold
      expect(thrownError).toBeInstanceOf(InsufficientUsdcError);
      expect((thrownError as InsufficientUsdcError).code).toBe("INSUFFICIENT_USDC");
    }
  );
});

// ---------------------------------------------------------------------------
// Property 15: ResearchBrief Assembly Completeness
// ---------------------------------------------------------------------------

/**
 * Arbitraries for generating valid PipelineState objects.
 *
 * assembleBrief() is a pure function — no mocks needed. We generate
 * structurally valid PipelineState objects and assert that the returned
 * ResearchBrief satisfies all data-integrity requirements.
 */

/** UUID v4 regex */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Arbitrary that generates a non-empty string of printable ASCII characters */
const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 80 }).filter(
  (s) => s.trim().length > 0
);

/** Arbitrary for a valid HTTPS URL */
const httpsUrlArb = fc
  .tuple(
    fc.stringMatching(/^[a-z0-9-]{3,20}$/),
    fc.stringMatching(/^[a-z0-9/-]{1,40}$/)
  )
  .map(([host, path]) => `https://${host}.example.com/${path}`);

/** Arbitrary for a single SearchResult with all required fields non-empty */
const searchResultArb = fc.record({
  title: nonEmptyStringArb,
  url: httpsUrlArb,
  snippet: nonEmptyStringArb,
});

/** Arbitrary for a single PaymentRecord */
const paymentServiceArb = fc.constantFrom(
  "sentinel" as const,
  "acedata-search" as const,
  "acedata-llm" as const,
  "acedata-image" as const
);

const paymentRecordArb = fc.record({
  service: paymentServiceArb,
  network: fc.constant("solana" as const),
  amountUsdc: fc
    .float({ min: Math.fround(0.001), max: Math.fround(1.0), noNaN: true })
    .map((n) => n.toFixed(6)),
  txHash: nonEmptyStringArb,
  settledAt: fc.integer({ min: 1_000_000_000, max: 9_999_999_999 }),
});

/** Exactly 4 payment records — one per required service */
const fourPaymentsArb = fc.tuple(
  fc.record({ ...paymentRecordArb.model, service: fc.constant("sentinel" as const) }),
  fc.record({ ...paymentRecordArb.model, service: fc.constant("acedata-search" as const) }),
  fc.record({ ...paymentRecordArb.model, service: fc.constant("acedata-llm" as const) }),
  fc.record({ ...paymentRecordArb.model, service: fc.constant("acedata-image" as const) })
).map(([a, b, c, d]) => [a, b, c, d]);

/**
 * Build a valid PipelineState whose `results` field has all required fields
 * populated so that assembleBrief() succeeds.
 */
const validPipelineStateArb = fc
  .tuple(
    fc.uuid(),                                                    // id
    nonEmptyStringArb,                                            // topic
    fc.integer({ min: 1_000_000_000, max: 9_999_999_999 }),      // createdAt (Unix seconds)
    fc.float({ min: Math.fround(0.01), max: Math.fround(10_000), noNaN: true }),            // solPrice > 0
    fc.array(searchResultArb, { minLength: 1, maxLength: 10 }),   // searchResults (non-empty)
    fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0), // analysis
    httpsUrlArb,                                                  // imageUrl
    fourPaymentsArb                                               // exactly 4 payments
  )
  .map(([id, topic, createdAt, solPrice, searchResults, analysis, imageUrl, payments]) => ({
    runId: id,
    topic,
    stage: "persist" as const,
    startedAt: createdAt * 1000,
    results: {
      id,
      topic,
      createdAt,
      solPrice,
      searchResults,
      analysis,
      imageUrl,
      payments,
    },
    errors: [],
  }));

describe("Property 15: ResearchBrief Assembly Completeness", () => {
  it(
    "**Validates: Requirements 9.1, 9.2, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6** — for any valid PipelineState, assembleBrief() returns a ResearchBrief with a UUID v4 id",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(brief.id).toMatch(UUID_V4_RE);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 15.2** — for any valid PipelineState, assembleBrief() returns a ResearchBrief with a positive Unix createdAt timestamp",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(typeof brief.createdAt).toBe("number");
          expect(brief.createdAt).toBeGreaterThan(0);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 15.3** — for any valid PipelineState, assembleBrief() returns a ResearchBrief with solPrice > 0",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(typeof brief.solPrice).toBe("number");
          expect(brief.solPrice).toBeGreaterThan(0);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 15.4** — for any valid PipelineState, assembleBrief() returns a non-empty searchResults array where each entry has non-empty title, url, and snippet",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(Array.isArray(brief.searchResults)).toBe(true);
          expect(brief.searchResults.length).toBeGreaterThan(0);
          for (const result of brief.searchResults) {
            expect(result.title.trim().length).toBeGreaterThan(0);
            expect(result.url.trim().length).toBeGreaterThan(0);
            expect(result.snippet.trim().length).toBeGreaterThan(0);
          }
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 15.5** — for any valid PipelineState, assembleBrief() returns a non-empty analysis string",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(typeof brief.analysis).toBe("string");
          expect(brief.analysis.trim().length).toBeGreaterThan(0);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 15.6** — for any valid PipelineState, assembleBrief() returns an imageUrl that is a valid HTTPS URL",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(typeof brief.imageUrl).toBe("string");
          expect(brief.imageUrl.startsWith("https://")).toBe(true);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 9.2** — for any valid PipelineState, assembleBrief() returns a payments array with exactly 4 entries",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(Array.isArray(brief.payments)).toBe(true);
          expect(brief.payments).toHaveLength(4);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1** — for any valid PipelineState, assembleBrief() returns a populated onChain object with ledgerTx, contentHash, and agentPda fields",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);
          expect(brief.onChain).toBeDefined();
          expect(brief.onChain).toHaveProperty("ledgerTx");
          expect(brief.onChain).toHaveProperty("contentHash");
          expect(brief.onChain).toHaveProperty("agentPda");
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.1, 9.2, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6** — combined: for any valid PipelineState, assembleBrief() returns a fully-formed ResearchBrief satisfying all structural invariants simultaneously",
    () => {
      fc.assert(
        fc.property(validPipelineStateArb, (state) => {
          const brief = assembleBrief(state);

          // id: UUID v4
          expect(brief.id).toMatch(UUID_V4_RE);

          // createdAt: positive Unix timestamp
          expect(brief.createdAt).toBeGreaterThan(0);

          // solPrice: positive number
          expect(brief.solPrice).toBeGreaterThan(0);

          // searchResults: non-empty, each entry has required fields
          expect(brief.searchResults.length).toBeGreaterThan(0);
          for (const r of brief.searchResults) {
            expect(r.title.trim().length).toBeGreaterThan(0);
            expect(r.url.trim().length).toBeGreaterThan(0);
            expect(r.snippet.trim().length).toBeGreaterThan(0);
          }

          // analysis: non-empty string
          expect(brief.analysis.trim().length).toBeGreaterThan(0);

          // imageUrl: valid HTTPS URL
          expect(brief.imageUrl.startsWith("https://")).toBe(true);

          // payments: exactly 4 entries
          expect(brief.payments).toHaveLength(4);

          // onChain: object with required fields
          expect(brief.onChain).toHaveProperty("ledgerTx");
          expect(brief.onChain).toHaveProperty("contentHash");
          expect(brief.onChain).toHaveProperty("agentPda");
        }),
        { numRuns: 100 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 2: Three Distinct AceDataCloud APIs
// ---------------------------------------------------------------------------

/**
 * Arbitrary that generates a valid PipelineState with all 4 payment records
 * (sentinel + acedata-search + acedata-llm + acedata-image), each with a
 * non-empty txHash.
 *
 * **Validates: Requirements 9.2, 15.7**
 */
const nonEmptyTxHashArb = fc
  .string({ minLength: 1, maxLength: 88 })
  .filter((s) => s.trim().length > 0);

const nonEmptyAmountArb = fc
  .float({ min: 0.000001, max: 10, noNaN: true })
  .map((n) => n.toFixed(6));

const briefSearchResultArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  url: fc.constant("https://example.com/result"),
  snippet: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
});

const analysisArb = fc
  .string({ minLength: 51, maxLength: 500 })
  .filter((s) => s.trim().length > 50);

const imageUrlArb = fc.constant("https://cdn.midjourney.com/test.png");

const solPriceArb = fc.float({ min: 0.01, max: 10000, noNaN: true });

/**
 * Build a PipelineState that has all 4 payment records with distinct,
 * non-empty txHashes. The state is fully populated so assembleBrief()
 * succeeds without throwing.
 */
const fullPipelineStateArb = fc
  .record({
    sentinelTxHash: nonEmptyTxHashArb,
    searchTxHash: nonEmptyTxHashArb,
    llmTxHash: nonEmptyTxHashArb,
    imageTxHash: nonEmptyTxHashArb,
    sentinelAmount: nonEmptyAmountArb,
    searchAmount: nonEmptyAmountArb,
    llmAmount: nonEmptyAmountArb,
    imageAmount: nonEmptyAmountArb,
    solPrice: solPriceArb,
    searchResult: briefSearchResultArb,
    analysis: analysisArb,
    imageUrl: imageUrlArb,
    topic: topicArb,
  })
  .map(
    ({
      sentinelTxHash,
      searchTxHash,
      llmTxHash,
      imageTxHash,
      sentinelAmount,
      searchAmount,
      llmAmount,
      imageAmount,
      solPrice,
      searchResult,
      analysis,
      imageUrl,
      topic,
    }) => {
      const now = Math.floor(Date.now() / 1000);
      const state: import("../../src/types/index.js").PipelineState = {
        runId: "test-run-id",
        topic,
        stage: "persist",
        startedAt: Date.now(),
        results: {
          id: "test-brief-id",
          topic,
          createdAt: now,
          solPrice,
          searchResults: [searchResult],
          analysis,
          imageUrl,
          payments: [
            {
              service: "sentinel",
              network: "solana",
              amountUsdc: sentinelAmount,
              txHash: sentinelTxHash,
              settledAt: now,
            },
            {
              service: "acedata-search",
              network: "solana",
              amountUsdc: searchAmount,
              txHash: searchTxHash,
              settledAt: now,
            },
            {
              service: "acedata-llm",
              network: "solana",
              amountUsdc: llmAmount,
              txHash: llmTxHash,
              settledAt: now,
            },
            {
              service: "acedata-image",
              network: "solana",
              amountUsdc: imageAmount,
              txHash: imageTxHash,
              settledAt: now,
            },
          ],
        },
        errors: [],
      };
      return state;
    }
  );

describe("Property 2: Three Distinct AceDataCloud APIs", () => {
  it(
    "**Validates: Requirements 9.2, 15.7** — for any ResearchBrief from a successful run, brief.payments contains exactly one 'acedata-search', one 'acedata-llm', and one 'acedata-image' record, each with a non-empty txHash",
    () => {
      fc.assert(
        fc.property(fullPipelineStateArb, (state) => {
          const brief = assembleBrief(state);

          const aceDataServices = ["acedata-search", "acedata-llm", "acedata-image"] as const;

          for (const service of aceDataServices) {
            // Filter payments for this service
            const records = brief.payments.filter((p) => p.service === service);

            // Exactly one record per AceDataCloud service
            expect(records).toHaveLength(1);

            // The record must have a non-empty txHash
            expect(records[0].txHash).toBeTruthy();
            expect(records[0].txHash.trim().length).toBeGreaterThan(0);
          }

          // Total payments must be exactly 4 (sentinel + 3 acedata)
          expect(brief.payments).toHaveLength(4);
        }),
        { numRuns: 50 }
      );
    }
  );

  it(
    "**Validates: Requirements 9.2, 15.7** — each AceDataCloud payment record preserves the txHash from the pipeline state (no hash is lost or overwritten during assembly)",
    () => {
      fc.assert(
        fc.property(fullPipelineStateArb, (state) => {
          const brief = assembleBrief(state);

          const payments = state.results.payments as import("../../src/types/index.js").PaymentRecord[];

          for (const service of ["acedata-search", "acedata-llm", "acedata-image"] as const) {
            const stateRecord = payments.find((p) => p.service === service)!;
            const briefRecord = brief.payments.find((p) => p.service === service)!;

            // txHash must be preserved exactly as-is from the pipeline state
            expect(briefRecord.txHash).toBe(stateRecord.txHash);
          }
        }),
        { numRuns: 50 }
      );
    }
  );
});

// ---------------------------------------------------------------------------
// Property 1: Autonomy
// ---------------------------------------------------------------------------

/**
 * **Property 1: Autonomy** — for any non-empty topic string, `agent.run(topic)`
 * (with all dependencies mocked) completes all pipeline stages and returns a
 * complete `ResearchBrief` without any interactive prompt or human input.
 *
 * **Validates: Requirements 11.1**
 *
 * The test verifies:
 *  1. `run(topic)` resolves (does not throw) for any non-empty topic.
 *  2. The returned value is a `ResearchBrief` with all required fields present
 *     and correctly typed.
 *  3. All 5 pipeline stages (discovery, sentinel, search, llm, image) are
 *     invoked exactly once — confirming the pipeline ran end-to-end without
 *     any human gate.
 *  4. `resultPersister.persist()` is called exactly once — confirming the
 *     on-chain persist stage also completed autonomously.
 */
describe("Property 1: Autonomy", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it(
    "**Validates: Requirements 11.1** — for any non-empty topic string, agent.run(topic) completes all pipeline stages and returns a complete ResearchBrief without human input",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          topicArb,
          async (topic: string) => {
            const {
              agent,
              toolDiscovery,
              sentinelClient,
              aceClient,
              resultPersister,
            } = buildInitializedAgent();

            // Run the full pipeline — no human interaction should be required
            const brief = await agent.run(topic);

            // ── 1. Return value is a complete ResearchBrief ──────────────────

            // id: non-empty string (UUID v4)
            expect(typeof brief.id).toBe("string");
            expect(brief.id.trim().length).toBeGreaterThan(0);

            // topic: matches the input topic
            expect(brief.topic).toBe(topic);

            // createdAt: positive Unix timestamp (seconds)
            expect(typeof brief.createdAt).toBe("number");
            expect(brief.createdAt).toBeGreaterThan(0);

            // solPrice: positive number from Sentinel
            expect(typeof brief.solPrice).toBe("number");
            expect(brief.solPrice).toBeGreaterThan(0);

            // searchResults: non-empty array, each entry has title/url/snippet
            expect(Array.isArray(brief.searchResults)).toBe(true);
            expect(brief.searchResults.length).toBeGreaterThan(0);
            for (const r of brief.searchResults) {
              expect(typeof r.title).toBe("string");
              expect(r.title.trim().length).toBeGreaterThan(0);
              expect(typeof r.url).toBe("string");
              expect(r.url.trim().length).toBeGreaterThan(0);
              expect(typeof r.snippet).toBe("string");
              expect(r.snippet.trim().length).toBeGreaterThan(0);
            }

            // analysis: non-empty string
            expect(typeof brief.analysis).toBe("string");
            expect(brief.analysis.trim().length).toBeGreaterThan(0);

            // imageUrl: valid HTTPS URL
            expect(typeof brief.imageUrl).toBe("string");
            expect(brief.imageUrl.startsWith("https://")).toBe(true);

            // payments: exactly 4 records
            expect(Array.isArray(brief.payments)).toBe(true);
            expect(brief.payments).toHaveLength(4);

            // onChain: populated object
            expect(brief.onChain).toBeDefined();
            expect(typeof brief.onChain.ledgerTx).toBe("string");
            expect(brief.onChain.ledgerTx.trim().length).toBeGreaterThan(0);
            expect(typeof brief.onChain.contentHash).toBe("string");
            expect(typeof brief.onChain.agentPda).toBe("string");

            // ── 2. All pipeline stages were invoked (no human gate) ──────────

            // discovery stage
            expect(toolDiscovery.findSentinel).toHaveBeenCalledTimes(1);

            // sentinel stage
            expect(sentinelClient.getPythPrice).toHaveBeenCalledTimes(1);
            expect(sentinelClient.getPythPrice).toHaveBeenCalledWith("SOL/USD");

            // search stage
            expect(aceClient.search).toHaveBeenCalledTimes(1);
            expect(aceClient.search).toHaveBeenCalledWith(topic);

            // llm stage
            expect(aceClient.chat).toHaveBeenCalledTimes(1);

            // image stage
            expect(aceClient.generateImage).toHaveBeenCalledTimes(1);

            // persist stage
            expect(resultPersister.persist).toHaveBeenCalledTimes(1);
          }
        ),
        { numRuns: 20 }
      );
    }
  );

  it(
    "**Validates: Requirements 11.1** — agent.run(topic) is fully autonomous: it does not block on any interactive prompt (resolves within a reasonable timeout)",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          topicArb,
          async (topic: string) => {
            const { agent } = buildInitializedAgent();

            // The run must complete without any blocking/interactive step.
            // We wrap in a race with a generous timeout to catch any accidental
            // blocking behaviour (e.g. readline, process.stdin reads).
            const TIMEOUT_MS = 5_000;

            const runPromise = agent.run(topic);
            const timeoutPromise = new Promise<never>((_, reject) =>
              setTimeout(
                () => reject(new Error(`agent.run() did not resolve within ${TIMEOUT_MS}ms — possible blocking/interactive prompt`)),
                TIMEOUT_MS
              )
            );

            // Must resolve before the timeout — no human input required
            const brief = await Promise.race([runPromise, timeoutPromise]);

            expect(brief).toBeDefined();
            expect(brief.topic).toBe(topic);
          }
        ),
        { numRuns: 10 }
      );
    }
  );

  it(
    "**Validates: Requirements 11.1** — agent.run(topic) returns a ResearchBrief whose payments array contains all four required service records",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          topicArb,
          async (topic: string) => {
            const { agent } = buildInitializedAgent();

            const brief = await agent.run(topic);

            const requiredServices = [
              "sentinel",
              "acedata-search",
              "acedata-llm",
              "acedata-image",
            ] as const;

            for (const service of requiredServices) {
              const records = brief.payments.filter((p) => p.service === service);
              expect(records).toHaveLength(1);
              expect(records[0].txHash.trim().length).toBeGreaterThan(0);
              expect(records[0].network).toBe("solana");
            }
          }
        ),
        { numRuns: 20 }
      );
    }
  );
});
