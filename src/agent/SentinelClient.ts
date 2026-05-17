/**
 * SentinelClient — calls the Synapse Sentinel agent via SAP x402 escrow
 * to retrieve a live Pyth oracle price.
 *
 * Responsibilities:
 *  - getPythPrice(asset): prepare x402 escrow payment, build payment headers,
 *    POST to Sentinel's /tools/get_price endpoint, parse and return PriceResult
 *
 * Requirements: 4.1, 4.2, 4.3, 4.5
 *
 * NOTE: The SAP SDK's x402 module lives in the high-level client and has no
 * subpath export, so the client is typed as `any` (same pattern as SapRegistrar
 * and ToolDiscovery).
 */

import { PublicKey } from "@solana/web3.js";
import type { PriceResult } from "../types/index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The Synapse Sentinel agent's wallet address on Solana mainnet.
 * Requirements: 4.1
 */
const SENTINEL_WALLET = new PublicKey(
  "Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph"
);

/**
 * The Sentinel endpoint that exposes the Pyth price oracle tool.
 * Requirements: 4.2
 */
const SENTINEL_ENDPOINT =
  "https://agent.sentinel.oobeprotocol.ai/tools/get_price";

// ---------------------------------------------------------------------------
// SentinelClient
// ---------------------------------------------------------------------------

export class SentinelClient {
  /**
   * @param sapClient - High-level SapClient from SapConnection.fromKeypair().
   *   Typed as `any` because the high-level client lives in the SDK's
   *   `core/client` module which has no subpath export in the package.json.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly sapClient: any) {}

  // -------------------------------------------------------------------------
  // getPythPrice
  // -------------------------------------------------------------------------

  /**
   * Retrieve a live asset price from the Pyth oracle via Synapse Sentinel.
   *
   * Steps:
   *  1. Call `sapClient.x402.preparePayment(SENTINEL_WALLET, opts)` to
   *     establish an escrow payment context (Requirement 4.1)
   *  2. Build payment headers with `sapClient.x402.buildPaymentHeaders(ctx)`
   *     (Requirement 4.2)
   *  3. POST to `SENTINEL_ENDPOINT` with `{ asset }` body and payment headers
   *     (Requirement 4.2)
   *  4. Parse the JSON response into a `PriceResult` (Requirement 4.3)
   *  5. Throw a descriptive error including the HTTP status code on non-200
   *     responses (Requirement 4.5)
   *
   * @param asset - Pyth price feed identifier, e.g. `"SOL/USD"`
   * @returns `PriceResult` with `price > 0`, `confidence`, `timestamp`, and
   *          a non-empty `settlementTx`
   * @throws Error with HTTP status code if Sentinel returns a non-200 response
   */
  async getPythPrice(asset: string): Promise<PriceResult> {
    // Step 1: Prepare SAP x402 escrow payment context (Requirement 4.1)
    const ctx = await this.sapClient.x402.preparePayment(SENTINEL_WALLET, {
      pricePerCall: 20_000,
      maxCalls: 5,
      deposit: 100_000,
    });

    // Step 2: Build payment headers from the prepared context (Requirement 4.2)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paymentHeaders: Record<string, string> =
      this.sapClient.x402.buildPaymentHeaders(ctx);

    // Step 3: POST to Sentinel endpoint with asset body and payment headers
    // (Requirement 4.2)
    const response = await fetch(SENTINEL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...paymentHeaders,
      },
      body: JSON.stringify({ asset }),
    });

    // Step 4: Throw descriptive error on non-200 response (Requirement 4.5)
    if (!response.ok) {
      let errorBody = "";
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body-read errors — status code is the primary signal
      }
      throw new Error(
        `[SentinelClient] Sentinel call failed with HTTP ${response.status}` +
          (errorBody ? `: ${errorBody}` : "")
      );
    }

    // Step 5: Parse response into PriceResult (Requirement 4.3)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await response.json();

    return {
      asset,
      price: data.price,
      confidence: data.confidence,
      timestamp: data.timestamp,
      settlementTx: data.settlement_tx ?? "",
    };
  }
}
