/**
 * Unit tests for SentinelClient.
 *
 * Tests the public method:
 *  - getPythPrice(asset): prepare x402 payment, build headers, POST to Sentinel,
 *    parse and return PriceResult
 *
 * Requirements: 4.3, 4.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SentinelClient } from '../../src/agent/SentinelClient.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_ENDPOINT = 'https://agent.sentinel.oobeprotocol.ai/tools/get_price';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

const mockPaymentCtx = { escrowId: 'escrow-abc-123', amount: 20_000 };

const mockPaymentHeaders = {
  'X-Payment-Token': 'tok_abc123',
  'X-Payment-Nonce': 'nonce_xyz',
};

const mockPriceResponse = {
  price: 185.42,
  confidence: 0.12,
  timestamp: 1700000000,
  settlement_tx: 'tx_settlement_abc123',
};

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

function buildMockSapClient(overrides?: {
  preparePayment?: () => Promise<unknown>;
  buildPaymentHeaders?: (ctx: unknown) => Record<string, string>;
}) {
  return {
    x402: {
      preparePayment:
        overrides?.preparePayment ??
        vi.fn().mockResolvedValue(mockPaymentCtx),
      buildPaymentHeaders:
        overrides?.buildPaymentHeaders ??
        vi.fn().mockReturnValue(mockPaymentHeaders),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers to build mock fetch responses
// ---------------------------------------------------------------------------

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

function makeErrorResponse(status: number, body = ''): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SentinelClient.getPythPrice', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Test 1: Payment context is prepared with the Sentinel wallet ──────────
  it('calls preparePayment with the Sentinel wallet address', async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(mockPriceResponse));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await client.getPythPrice('SOL/USD');

    expect(sapClient.x402.preparePayment).toHaveBeenCalledTimes(1);
    // First argument should be a PublicKey whose toBase58() is the Sentinel wallet
    const [walletArg] = (sapClient.x402.preparePayment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(walletArg.toBase58()).toBe('Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph');
  });

  // ── Test 2: Payment headers are built from the prepared context ───────────
  it('calls buildPaymentHeaders with the context returned by preparePayment', async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(mockPriceResponse));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await client.getPythPrice('SOL/USD');

    expect(sapClient.x402.buildPaymentHeaders).toHaveBeenCalledTimes(1);
    expect(sapClient.x402.buildPaymentHeaders).toHaveBeenCalledWith(mockPaymentCtx);
  });

  // ── Test 3: Payment headers are attached to the POST request ─────────────
  it('attaches payment headers and Content-Type to the POST request', async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(mockPriceResponse));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await client.getPythPrice('SOL/USD');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];

    expect(url).toBe(SENTINEL_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>)['X-Payment-Token']).toBe('tok_abc123');
    expect((init.headers as Record<string, string>)['X-Payment-Nonce']).toBe('nonce_xyz');
  });

  // ── Test 4: Asset is sent in the POST body ────────────────────────────────
  it('sends the asset in the JSON request body', async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(mockPriceResponse));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await client.getPythPrice('BTC/USD');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ asset: 'BTC/USD' });
  });

  // ── Test 5: Returns PriceResult with price > 0 and non-empty settlementTx ─
  it('returns PriceResult with price > 0 and non-empty settlementTx', async () => {
    fetchSpy.mockResolvedValue(makeOkResponse(mockPriceResponse));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    const result = await client.getPythPrice('SOL/USD');

    expect(result.asset).toBe('SOL/USD');
    expect(result.price).toBeGreaterThan(0);
    expect(result.price).toBe(185.42);
    expect(result.confidence).toBe(0.12);
    expect(result.timestamp).toBe(1700000000);
    expect(result.settlementTx).toBe('tx_settlement_abc123');
    expect(result.settlementTx.length).toBeGreaterThan(0);
  });

  // ── Test 6: Non-200 response → error includes HTTP status code ────────────
  it('throws an error containing the HTTP status code on non-200 response', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(402, 'Payment required'));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await expect(client.getPythPrice('SOL/USD')).rejects.toThrow('402');
  });

  // ── Test 7: Non-200 response → error message includes body text ───────────
  it('includes the response body text in the error message on non-200 response', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(500, 'Internal Server Error'));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await expect(client.getPythPrice('SOL/USD')).rejects.toThrow('Internal Server Error');
  });

  // ── Test 8: 404 response → error includes 404 status ─────────────────────
  it('throws an error with status 404 when Sentinel returns 404', async () => {
    fetchSpy.mockResolvedValue(makeErrorResponse(404));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    await expect(client.getPythPrice('ETH/USD')).rejects.toThrow('404');
  });

  // ── Test 9: settlement_tx missing → settlementTx defaults to empty string ─
  it('returns settlementTx as empty string when settlement_tx is absent in response', async () => {
    const responseWithoutTx = { price: 100, confidence: 0.05, timestamp: 1700000001 };
    fetchSpy.mockResolvedValue(makeOkResponse(responseWithoutTx));
    const sapClient = buildMockSapClient();
    const client = new SentinelClient(sapClient);

    const result = await client.getPythPrice('SOL/USD');

    expect(result.settlementTx).toBe('');
  });

  // ── Test 10: preparePayment failure propagates ────────────────────────────
  it('propagates errors thrown by preparePayment', async () => {
    const sapClient = buildMockSapClient({
      preparePayment: vi.fn().mockRejectedValue(new Error('Escrow setup failed')),
    });
    const client = new SentinelClient(sapClient);

    await expect(client.getPythPrice('SOL/USD')).rejects.toThrow('Escrow setup failed');
  });
});
