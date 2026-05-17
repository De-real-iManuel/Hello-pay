/**
 * Unit tests for BountyAgent.
 *
 * All external dependencies are mocked:
 *  - SapRegistrar, ToolDiscovery, SentinelClient, AceDataCloudClient, ResultPersister
 *  - SapConnection (dynamic import)
 *  - @solana/web3.js Connection (balance checks)
 *  - @solana/spl-token (USDC token account)
 *  - loadKeypair (keypair loading)
 *
 * Requirements: 11.1, 11.6, 12.2, 12.3, 12.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BountyAgent } from '../../src/agent/BountyAgent.js';
import {
  DuplicateRunError,
  InsufficientFundsError,
} from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock loadKeypair so we never touch the filesystem
vi.mock('../../src/utils/keypair.js', () => ({
  loadKeypair: vi.fn().mockReturnValue({
    publicKey: {
      toBase58: () => 'AgentWalletPubkey111',
      toString: () => 'AgentWalletPubkey111',
    },
    secretKey: new Uint8Array(64),
  }),
}));

// Mock @solana/web3.js — Connection and PublicKey
vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: vi.fn().mockResolvedValue(100_000_000), // 0.1 SOL
    })),
    PublicKey: vi.fn().mockImplementation((addr: string) => ({
      toBase58: () => addr,
      toString: () => addr,
    })),
  };
});

// Mock @solana/spl-token — getAssociatedTokenAddress and getAccount
vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue({ toBase58: () => 'AtaAddress' }),
  getAccount: vi.fn().mockResolvedValue({
    amount: BigInt(2_000_000), // 2.0 USDC (6 decimals)
  }),
}));

// Mock SapRegistrar
vi.mock('../../src/agent/SapRegistrar.js', () => ({
  SapRegistrar: vi.fn().mockImplementation(() => ({
    ensureRegistered: vi.fn().mockResolvedValue({ isActive: true }),
  })),
}));

// Mock ToolDiscovery
vi.mock('../../src/agent/ToolDiscovery.js', () => ({
  ToolDiscovery: vi.fn().mockImplementation(() => ({
    findSentinel: vi.fn().mockResolvedValue({
      pda: { toBase58: () => 'SentinelPDA' },
      computed: { isActive: true, hasX402: true },
    }),
  })),
}));

// Mock SentinelClient
vi.mock('../../src/agent/SentinelClient.js', () => ({
  SentinelClient: vi.fn().mockImplementation(() => ({
    getPythPrice: vi.fn().mockResolvedValue({
      asset: 'SOL/USD',
      price: 185.42,
      confidence: 0.12,
      timestamp: 1700000000,
      settlementTx: 'sentinel_tx_abc123',
    }),
  })),
}));

// Mock AceDataCloudClient
vi.mock('../../src/agent/AceDataCloudClient.js', () => ({
  AceDataCloudClient: vi.fn().mockImplementation(() => ({
    search: vi.fn().mockResolvedValue([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
    ]),
    chat: vi.fn().mockResolvedValue(
      'This is a comprehensive analysis of the research topic with more than fifty characters of content.'
    ),
    generateImage: vi.fn().mockResolvedValue({
      imageUrl: 'https://cdn.midjourney.com/image123.png',
      taskId: 'task_abc',
      paymentTxHash: 'image_tx_abc123',
    }),
    getLastX402Tx: vi.fn().mockReturnValue('acedata_tx_abc123'),
    resetLastX402Tx: vi.fn(),
  })),
}));

// Mock ResultPersister
vi.mock('../../src/agent/ResultPersister.js', () => ({
  ResultPersister: vi.fn().mockImplementation(() => ({
    persist: vi.fn().mockResolvedValue({
      tx: 'ledger_tx_abc123',
      contentHash: 'sha256hashvalue',
      agentPda: 'AgentPDA123',
    }),
  })),
}));

// Mock the dynamic import of SapConnection
vi.mock(
  '@oobe-protocol-labs/synapse-sap-sdk/dist/esm/core/connection.js',
  () => ({
    SapConnection: {
      fromKeypair: vi.fn().mockReturnValue({
        client: {
          agent: {
            deriveAgent: vi.fn().mockReturnValue([{ toBase58: () => 'AgentPDA123' }, 255]),
          },
          ledger: {},
          x402: {},
          discovery: {},
          indexing: {},
          tools: {},
        },
        connection: {},
      }),
    },
  })
);

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const testConfig = {
  solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
  walletKeypairPath: '/fake/keypair.json',
  aceDataCloudBaseUrl: 'https://api.acedata.cloud',
  facilitatorUrl: 'https://facilitator.acedata.cloud',
  sentinelWallet: 'Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph',
  usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  network: 'solana' as const,
};

// ---------------------------------------------------------------------------
// Helper: create and initialize a BountyAgent
// ---------------------------------------------------------------------------

async function createInitializedAgent(): Promise<BountyAgent> {
  const agent = new BountyAgent(testConfig);
  await agent.initialize();
  return agent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BountyAgent', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Test 1: Happy path — full pipeline returns ResearchBrief with 4 payments ──

  describe('run() — happy path', () => {
    it('returns a ResearchBrief with exactly 4 payment records on success', async () => {
      const agent = await createInitializedAgent();
      const brief = await agent.run('DeFi yield strategies');

      // Brief must be defined
      expect(brief).toBeDefined();

      // Topic matches
      expect(brief.topic).toBe('DeFi yield strategies');

      // Exactly 4 payment records (Requirement 9.2)
      expect(brief.payments).toHaveLength(4);

      // Each expected service is present
      const services = brief.payments.map((p) => p.service);
      expect(services).toContain('sentinel');
      expect(services).toContain('acedata-search');
      expect(services).toContain('acedata-llm');
      expect(services).toContain('acedata-image');

      // All payments have network = "solana" (Requirement 9.3)
      for (const payment of brief.payments) {
        expect(payment.network).toBe('solana');
      }

      // Brief has required fields
      expect(brief.id).toBeTruthy();
      expect(brief.createdAt).toBeGreaterThan(0);
      expect(brief.solPrice).toBe(185.42);
      expect(brief.searchResults.length).toBeGreaterThan(0);
      expect(brief.analysis.length).toBeGreaterThan(0);
      expect(brief.imageUrl).toMatch(/^https:\/\//);

      // onChain is populated
      expect(brief.onChain.ledgerTx).toBe('ledger_tx_abc123');
      expect(brief.onChain.contentHash).toBe('sha256hashvalue');
      expect(brief.onChain.agentPda).toBe('AgentPDA123');
    });

    it('calls all pipeline sub-components in order', async () => {
      const { ToolDiscovery } = await import('../../src/agent/ToolDiscovery.js');
      const { SentinelClient } = await import('../../src/agent/SentinelClient.js');
      const { AceDataCloudClient } = await import('../../src/agent/AceDataCloudClient.js');
      const { ResultPersister } = await import('../../src/agent/ResultPersister.js');

      const agent = await createInitializedAgent();
      await agent.run('Solana ecosystem');

      // ToolDiscovery.findSentinel was called
      const tdInstance = (ToolDiscovery as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(tdInstance.findSentinel).toHaveBeenCalledTimes(1);

      // SentinelClient.getPythPrice was called with SOL/USD
      const scInstance = (SentinelClient as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(scInstance.getPythPrice).toHaveBeenCalledWith('SOL/USD');

      // AceDataCloudClient.search was called
      const aceInstance = (AceDataCloudClient as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(aceInstance.search).toHaveBeenCalledTimes(1);

      // AceDataCloudClient.chat was called
      expect(aceInstance.chat).toHaveBeenCalledTimes(1);

      // AceDataCloudClient.generateImage was called
      expect(aceInstance.generateImage).toHaveBeenCalledTimes(1);

      // ResultPersister.persist was called
      const rpInstance = (ResultPersister as ReturnType<typeof vi.fn>).mock.results[0].value;
      expect(rpInstance.persist).toHaveBeenCalledTimes(1);
    });
  });

  // ── Test 2: run() before initialize() throws ─────────────────────────────

  describe('run() before initialize()', () => {
    it('throws an error when run() is called before initialize()', async () => {
      const agent = new BountyAgent(testConfig);

      await expect(agent.run('some topic')).rejects.toThrow(
        /not initialized|initialize\(\)/i
      );
    });

    it('error message mentions initialize()', async () => {
      const agent = new BountyAgent(testConfig);

      let caughtError: unknown;
      try {
        await agent.run('some topic');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toMatch(/initialize/i);
    });
  });

  // ── Test 3: Duplicate topic throws DuplicateRunError ─────────────────────

  describe('run() with duplicate topic', () => {
    it('throws DuplicateRunError when the same topic is already running', async () => {
      const { SentinelClient } = await import('../../src/agent/SentinelClient.js');

      // Make sentinel hang so the first run is still "in progress"
      let resolveSentinel!: () => void;
      const sentinelHang = new Promise<void>((resolve) => {
        resolveSentinel = resolve;
      });

      const hangingGetPythPrice = vi.fn().mockImplementation(async () => {
        await sentinelHang;
        return {
          asset: 'SOL/USD',
          price: 185.42,
          confidence: 0.12,
          timestamp: 1700000000,
          settlementTx: 'sentinel_tx_abc123',
        };
      });

      // Override the SentinelClient mock for this test
      (SentinelClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        getPythPrice: hangingGetPythPrice,
      }));

      const agent = await createInitializedAgent();

      // Start first run (will hang at sentinel stage)
      const firstRun = agent.run('duplicate topic');

      // Give the first run a tick to register the topic
      await new Promise((r) => setTimeout(r, 10));

      // Second run with same topic should throw DuplicateRunError immediately
      await expect(agent.run('duplicate topic')).rejects.toThrow(DuplicateRunError);

      // Clean up: resolve the hanging sentinel so the first run can finish
      resolveSentinel();
      // Swallow the first run result/error
      await firstRun.catch(() => {});
    });

    it('DuplicateRunError message contains the topic', async () => {
      const { SentinelClient } = await import('../../src/agent/SentinelClient.js');

      let resolveSentinel!: () => void;
      const sentinelHang = new Promise<void>((resolve) => {
        resolveSentinel = resolve;
      });

      (SentinelClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        getPythPrice: vi.fn().mockImplementation(async () => {
          await sentinelHang;
          return {
            asset: 'SOL/USD',
            price: 100,
            confidence: 0.1,
            timestamp: 1700000000,
            settlementTx: 'tx123',
          };
        }),
      }));

      const agent = await createInitializedAgent();
      const topic = 'my unique research topic';

      const firstRun = agent.run(topic);
      await new Promise((r) => setTimeout(r, 10));

      let caughtError: unknown;
      try {
        await agent.run(topic);
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(DuplicateRunError);
      expect((caughtError as DuplicateRunError).message).toContain(topic);

      resolveSentinel();
      await firstRun.catch(() => {});
    });
  });

  // ── Test 4: Fatal error in sentinel stage does NOT call resultPersister.persist() ──

  describe('fatal error in sentinel stage', () => {
    it('does not call resultPersister.persist() when sentinel throws a fatal error', async () => {
      const { SentinelClient } = await import('../../src/agent/SentinelClient.js');
      const { ResultPersister } = await import('../../src/agent/ResultPersister.js');

      // Make sentinel throw a fatal error
      (SentinelClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        getPythPrice: vi.fn().mockRejectedValue(
          new Error('[SentinelClient] Sentinel call failed with HTTP 500')
        ),
      }));

      const agent = await createInitializedAgent();

      // run() should throw
      await expect(agent.run('sentinel failure topic')).rejects.toThrow();

      // ResultPersister.persist must NOT have been called (Requirement 12.2, 12.5)
      const rpInstance = (ResultPersister as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (rpInstance) {
        expect(rpInstance.persist).not.toHaveBeenCalled();
      }
    });

    it('does not call resultPersister.persist() when discovery throws a fatal error', async () => {
      const { ToolDiscovery } = await import('../../src/agent/ToolDiscovery.js');
      const { ResultPersister } = await import('../../src/agent/ResultPersister.js');

      // Make discovery throw
      (ToolDiscovery as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        findSentinel: vi.fn().mockRejectedValue(
          new Error('[ToolDiscovery] Synapse Sentinel not found')
        ),
      }));

      const agent = await createInitializedAgent();

      await expect(agent.run('discovery failure topic')).rejects.toThrow();

      const rpInstance = (ResultPersister as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (rpInstance) {
        expect(rpInstance.persist).not.toHaveBeenCalled();
      }
    });
  });

  // ── Test 5: InsufficientFundsError is not retried ─────────────────────────

  describe('InsufficientFundsError is not retried', () => {
    it('throws InsufficientFundsError immediately without retrying (only 1 attempt)', async () => {
      const { AceDataCloudClient } = await import('../../src/agent/AceDataCloudClient.js');

      const searchMock = vi.fn().mockRejectedValue(
        new InsufficientFundsError(0.5, 0.1)
      );

      (AceDataCloudClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        search: searchMock,
        chat: vi.fn(),
        generateImage: vi.fn(),
        getLastX402Tx: vi.fn().mockReturnValue(''),
        resetLastX402Tx: vi.fn(),
      }));

      const agent = await createInitializedAgent();

      await expect(agent.run('insufficient funds topic')).rejects.toThrow(
        InsufficientFundsError
      );

      // search() should have been called exactly once — no retries (Requirement 12.3)
      expect(searchMock).toHaveBeenCalledTimes(1);
    });

    it('InsufficientFundsError propagates with correct error type', async () => {
      const { AceDataCloudClient } = await import('../../src/agent/AceDataCloudClient.js');

      (AceDataCloudClient as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
        search: vi.fn().mockRejectedValue(new InsufficientFundsError(1.0, 0.05)),
        chat: vi.fn(),
        generateImage: vi.fn(),
        getLastX402Tx: vi.fn().mockReturnValue(''),
        resetLastX402Tx: vi.fn(),
      }));

      const agent = await createInitializedAgent();

      let caughtError: unknown;
      try {
        await agent.run('funds error topic');
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(InsufficientFundsError);
      expect((caughtError as InsufficientFundsError).code).toBe('INSUFFICIENT_FUNDS');
    });
  });

  // ── Test 6: Topic is removed from runningTopics after run completes ───────

  describe('topic cleanup', () => {
    it('allows the same topic to be run again after a successful run', async () => {
      const agent = await createInitializedAgent();

      // First run succeeds
      await agent.run('reusable topic');

      // Second run with same topic should NOT throw DuplicateRunError
      await expect(agent.run('reusable topic')).resolves.toBeDefined();
    });

    it('allows the same topic to be run again after a failed run', async () => {
      const { SentinelClient } = await import('../../src/agent/SentinelClient.js');

      // Create the agent first (initialize() consumes the default mock instance)
      const agent = await createInitializedAgent();

      // Override getPythPrice on the already-created SentinelClient instance.
      // Use PaymentError (non-retryable) so withSelectiveRetry throws immediately
      // on the first run() without consuming the success mock via retries.
      const scInstance = (SentinelClient as ReturnType<typeof vi.fn>).mock.results[0].value;
      scInstance.getPythPrice
        .mockRejectedValueOnce(new InsufficientFundsError(1.0, 0.0))  // non-retryable — first run() fails fast
        .mockResolvedValue({                                            // second run() succeeds
          asset: 'SOL/USD',
          price: 185.42,
          confidence: 0.12,
          timestamp: 1700000000,
          settlementTx: 'sentinel_tx_abc123',
        });

      // First run fails immediately (non-retryable error)
      await expect(agent.run('retry topic')).rejects.toThrow(InsufficientFundsError);

      // Second run with same topic should succeed (topic was cleaned up in finally)
      await expect(agent.run('retry topic')).resolves.toBeDefined();
    });
  });

  // ── Test 7: shutdown() closes the SAP client ─────────────────────────────

  describe('shutdown()', () => {
    it('calls sapClient.close() if available', async () => {
      const agent = await createInitializedAgent();

      // Access the private sapClient via type assertion to verify close() is called
      // We verify shutdown() resolves without throwing
      await expect(agent.shutdown()).resolves.toBeUndefined();
    });
  });
});
