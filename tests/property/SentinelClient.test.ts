/**
 * Property-based tests for SentinelClient in src/agent/SentinelClient.ts
 *
 * **Property 3: Sentinel Usage** — for any successful `getPythPrice()` call,
 * the returned `PriceResult.price` is greater than 0 and `settlementTx` is a
 * non-empty string.
 *
 * **Validates: Requirements 4.4, 9.2**
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { SentinelClient } from '../../src/agent/SentinelClient.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock sapClient whose x402 methods return the provided
 * payment context and headers.
 */
function buildMockSapClient(paymentHeaders: Record<string, string> = {}) {
  return {
    x402: {
      preparePayment: vi.fn().mockResolvedValue({ __ctx: true }),
      buildPaymentHeaders: vi.fn().mockReturnValue(paymentHeaders),
    },
  };
}

/**
 * Install a global `fetch` mock that returns a successful 200 response
 * whose JSON body contains the given price and settlement_tx values.
 */
function mockFetchSuccess(price: number, settlementTx: string) {
  const mockResponse = {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({
      price,
      confidence: 0.01,
      timestamp: Date.now(),
      settlement_tx: settlementTx,
    }),
    text: vi.fn().mockResolvedValue(''),
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
  return mockResponse;
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Generates a positive float price (> 0).
 * fc.float requires 32-bit float boundaries — use Math.fround to convert.
 */
const positivePriceArb = fc.float({ min: Math.fround(0.01), noNaN: true });

/**
 * Generates a non-empty string to use as a settlement transaction hash.
 * We use printable ASCII strings of length 1–88 to mimic realistic tx hashes.
 */
const nonEmptySettlementTxArb = fc.string({ minLength: 1, maxLength: 88 }).filter(
  (s) => s.trim().length > 0
);

/**
 * Generates a valid Pyth asset identifier string (non-empty).
 */
const assetArb = fc.constantFrom('SOL/USD', 'BTC/USD', 'ETH/USD', 'USDC/USD');

// ---------------------------------------------------------------------------
// Property 3: Sentinel Usage
// ---------------------------------------------------------------------------

describe('SentinelClient Properties', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('Property 3: Sentinel Usage', () => {
    it(
      '**Validates: Requirements 4.4, 9.2** — for any positive price and non-empty settlementTx, getPythPrice() returns price > 0 and non-empty settlementTx',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            positivePriceArb,
            nonEmptySettlementTxArb,
            assetArb,
            async (price: number, settlementTx: string, asset: string) => {
              // Arrange: mock fetch to return the generated price + settlementTx
              mockFetchSuccess(price, settlementTx);
              const sapClient = buildMockSapClient({ 'X-SAP-Payment': 'mock-header' });
              const client = new SentinelClient(sapClient);

              // Act
              const result = await client.getPythPrice(asset);

              // Assert: price must be > 0
              expect(result.price).toBeGreaterThan(0);
              expect(result.price).toBe(price);

              // Assert: settlementTx must be a non-empty string
              expect(typeof result.settlementTx).toBe('string');
              expect(result.settlementTx.length).toBeGreaterThan(0);
              expect(result.settlementTx).toBe(settlementTx);

              // Assert: asset is echoed back correctly
              expect(result.asset).toBe(asset);

              // Assert: sapClient.x402 methods were called
              expect(sapClient.x402.preparePayment).toHaveBeenCalledOnce();
              expect(sapClient.x402.buildPaymentHeaders).toHaveBeenCalledOnce();
            }
          ),
          { numRuns: 5 }
        );
      }
    );

    it(
      '**Validates: Requirements 4.4** — getPythPrice() always calls preparePayment and buildPaymentHeaders before fetching',
      async () => {
        await fc.assert(
          fc.asyncProperty(
            positivePriceArb,
            nonEmptySettlementTxArb,
            async (price: number, settlementTx: string) => {
              mockFetchSuccess(price, settlementTx);
              const sapClient = buildMockSapClient();
              const client = new SentinelClient(sapClient);

              await client.getPythPrice('SOL/USD');

              // x402 payment preparation must always precede the fetch call
              const prepareOrder = (sapClient.x402.preparePayment as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
              const buildOrder = (sapClient.x402.buildPaymentHeaders as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
              const fetchMock = vi.mocked(global.fetch);
              const fetchOrder = fetchMock.mock.invocationCallOrder[0];

              expect(prepareOrder).toBeLessThan(fetchOrder);
              expect(buildOrder).toBeLessThan(fetchOrder);
            }
          ),
          { numRuns: 5 }
        );
      }
    );
  });
});
