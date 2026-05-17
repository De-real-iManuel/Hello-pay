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
import { BountyAgent } from "../../src/agent/BountyAgent.js";
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
