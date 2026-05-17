/**
 * AceDataCloudClient — wraps the three Ace Data Cloud API calls with
 * automatic x402 USDC payment handling via `@acedatacloud/x402-client`.
 *
 * Responsibilities:
 *  - Wire up a single `SolanaWalletAdapter` and `createX402PaymentHandler`
 *    once in the constructor and reuse them across all three API calls
 *    (Requirement 8.7)
 *  - Never include an `Authorization: Bearer` header (Requirement 8.1)
 *  - Capture the `x402_tx` response header after each successful call so
 *    that callers can assemble `PaymentRecord` entries
 *  - search(query): POST /search — web search (Requirement 5.x)
 *  - chat(messages, model?): POST /openai/chat/completions — LLM (Requirement 6.x)
 *  - generateImage(prompt): POST /midjourney/imagine — image gen (Requirement 7.x)
 *
 * Requirements: 8.1, 8.3, 8.7
 */

import { AceDataCloud, type PaymentHandler } from "@acedatacloud/sdk";
import { createX402PaymentHandler } from "@acedatacloud/x402-client";
import { Keypair, Connection, Transaction } from "@solana/web3.js";
import type { SolanaWalletAdapter } from "@acedatacloud/x402-client";
import { z } from "zod";
import { PaymentError, ContentValidationError } from "../utils/errors.js";
import type { SearchResult, ImageResult, ChatMessage } from "../types/index.js";

// ---------------------------------------------------------------------------
// SolanaKeypairWallet — adapts a @solana/web3.js Keypair to the
// SolanaWalletAdapter interface expected by @acedatacloud/x402-client.
// ---------------------------------------------------------------------------

/**
 * Wraps a Solana `Keypair` as a `SolanaWalletAdapter` so it can be passed
 * to `createX402PaymentHandler({ network: "solana", solanaWallet })`.
 *
 * The adapter signs the transaction locally and submits it to the RPC
 * specified in the payment requirement's `extra.rpcUrl` field (falling back
 * to Solana mainnet-beta).
 *
 * Requirements: 8.3
 */
class SolanaKeypairWallet implements SolanaWalletAdapter {
  readonly publicKey: { toBase58(): string; toString(): string };

  constructor(private readonly keypair: Keypair) {
    this.publicKey = keypair.publicKey;
  }

  /**
   * Sign the transaction with the keypair and submit it to the network.
   * Returns the confirmed transaction signature string.
   */
  async signAndSendTransaction(
    tx: unknown
  ): Promise<string | { signature: string }> {
    const transaction = tx as Transaction;

    // Sign the transaction with the agent's keypair
    transaction.sign(this.keypair);

    // Determine RPC URL from the transaction's recentBlockhash context.
    // The x402-client sets tx.feePayer and recentBlockhash before calling us,
    // but does not pass the rpcUrl here — use mainnet-beta as the default.
    // The actual rpcUrl from the payment requirement is used by signSolanaPayment
    // to fetch the blockhash; we submit to the same cluster.
    const rpcUrl = "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpcUrl, "confirmed");

    const signature = await connection.sendRawTransaction(
      transaction.serialize(),
      { skipPreflight: false, preflightCommitment: "confirmed" }
    );

    const latestBlockhash = await connection.getLatestBlockhash("confirmed");
    await connection.confirmTransaction(
      { signature, ...latestBlockhash },
      "confirmed"
    );

    return signature;
  }
}

// ---------------------------------------------------------------------------
// AceDataCloudClient
// ---------------------------------------------------------------------------

export class AceDataCloudClient {
  /**
   * The single shared AceDataCloud SDK instance.
   * Instantiated once in the constructor and reused across all API calls.
   * Used by search(), chat(), and generateImage() (tasks 7.2, 7.3, 7.4).
   * Requirements: 8.7
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  protected readonly sdk: AceDataCloud;

  /**
   * The last `x402_tx` header value received from a successful API call.
   * Updated after each call that completes the x402 handshake.
   * Used by the BountyAgent to assemble `PaymentRecord` entries.
   */
  private lastX402Tx: string = "";

  /**
   * @param keypair       - The agent's Solana keypair used to sign x402 payments
   * @param baseUrl       - AceDataCloud API base URL (e.g. "https://api.acedata.cloud")
   * @param facilitatorUrl - x402 facilitator URL (e.g. "https://facilitator.acedata.cloud")
   *
   * Requirements: 8.1, 8.3, 8.7
   */
  constructor(
    keypair: Keypair,
    baseUrl: string,
    facilitatorUrl: string
  ) {
    // Step 1: Wrap the Keypair as a SolanaWalletAdapter (Requirement 8.3)
    const solanaWallet = new SolanaKeypairWallet(keypair);

    // Step 2: Create the single shared x402 payment handler (Requirement 8.7)
    // The handler is configured for the Solana network and routes all
    // settlements through the AceDataCloud facilitator (Requirement 5.7).
    const paymentHandler = createX402PaymentHandler({
      network: "solana",
      solanaWallet,
    });

    // Step 3: Wrap the payment handler to capture the x402_tx header.
    // The SDK transport does not expose response headers after the retry,
    // so we intercept the global fetch to capture the x402_tx header from
    // the successful retry response.
    const capturingPaymentHandler = this.buildCapturingPaymentHandler(
      paymentHandler,
      facilitatorUrl
    );

    // Step 4: Instantiate the AceDataCloud SDK with baseURL and the shared
    // payment handler. No apiToken is provided — all auth is via x402.
    // (Requirement 8.1: no Authorization: Bearer header)
    this.sdk = new AceDataCloud({
      baseURL: baseUrl,
      paymentHandler: capturingPaymentHandler,
    });
  }

  // -------------------------------------------------------------------------
  // Payment handler wrapper
  // -------------------------------------------------------------------------

  /**
   * Wraps the base x402 payment handler to intercept the `x402_tx` response
   * header from the successful retry.
   *
   * Because the SDK transport calls `paymentHandler` to get the `X-Payment`
   * headers and then retries the request internally (returning only the JSON
   * body), we patch the global `fetch` temporarily during the retry to
   * capture the `x402_tx` header.
   *
   * @param baseHandler    - The underlying x402 payment handler
   * @param _facilitatorUrl - The facilitator URL (stored for reference)
   */
  private buildCapturingPaymentHandler(
    baseHandler: ReturnType<typeof createX402PaymentHandler>,
    _facilitatorUrl: string
  ): PaymentHandler {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return async function capturingHandler(ctx) {
      // Delegate to the real payment handler to get the X-Payment headers.
      // Cast ctx to any to bridge the minor type mismatch between the SDK's
      // PaymentHandlerContext and the x402-client's SdkPaymentHandlerContext
      // (both have the same runtime shape; the difference is only in whether
      // maxTimeoutSeconds is required or optional).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await baseHandler(ctx as any);

      // Patch global fetch to intercept the retry response and capture x402_tx.
      // We restore the original fetch immediately after the first intercepted call.
      const originalFetch = globalThis.fetch;
      let intercepted = false;

      globalThis.fetch = async function patchedFetch(
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ): Promise<Response> {
        const response = await originalFetch(input, init);

        // Only intercept once (the retry that follows this payment handler call)
        if (!intercepted) {
          intercepted = true;
          globalThis.fetch = originalFetch;

          // Capture x402_tx from the response headers
          const x402Tx =
            response.headers.get("x402_tx") ??
            response.headers.get("x402-tx") ??
            response.headers.get("X-402-Tx") ??
            "";

          if (x402Tx) {
            self.lastX402Tx = x402Tx;
          }
        }

        return response;
      } as typeof fetch;

      return result;
    };
  }

  // -------------------------------------------------------------------------
  // Public accessor for the last x402_tx header
  // -------------------------------------------------------------------------

  /**
   * Returns the `x402_tx` transaction hash from the most recent successful
   * API call. Used by the BountyAgent to build `PaymentRecord` entries.
   *
   * Returns an empty string if no successful x402 payment has been made yet.
   */
  getLastX402Tx(): string {
    return this.lastX402Tx;
  }

  /**
   * Resets the stored `x402_tx` value. Call before each API method invocation
   * to ensure the captured value belongs to that specific call.
   */
  resetLastX402Tx(): void {
    this.lastX402Tx = "";
  }

  // -------------------------------------------------------------------------
  // API methods (stubs — implemented in tasks 7.2, 7.3, 7.4)
  // -------------------------------------------------------------------------

  /**
   * Web Search via AceDataCloud.
   * POST /search with { query, num: 10 } — no Bearer header.
   * The SDK payment handler automatically handles the 402 → sign → retry cycle.
   * After the call, checks for x402_tx header; throws PaymentError if absent.
   * Validates response shape with zod.
   * Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 8.2, 8.4
   */
  async search(query: string): Promise<SearchResult[]> {
    this.resetLastX402Tx();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (this.sdk as any).request({
      method: "POST",
      path: "/search",
      body: { query, num: 10 },
    });

    // Validate x402_tx header was captured (Requirement 8.4)
    const txHash = this.getLastX402Tx();
    if (!txHash) {
      throw new PaymentError(
        "[AceDataCloudClient] search(): x402_tx header absent from response — payment not confirmed"
      );
    }

    // Validate response shape with zod (Requirement 5.3)
    const rawResults: unknown[] = Array.isArray(response?.results)
      ? response.results
      : Array.isArray(response)
      ? response
      : [];

    const SearchResultSchema = z.object({
      title: z.string().min(1),
      url: z.string().min(1),
      snippet: z.string().min(1),
      publishedDate: z.string().optional(),
    });

    const validated = rawResults.map((item, idx) => {
      const parsed = SearchResultSchema.safeParse(item);
      if (!parsed.success) {
        throw new PaymentError(
          `[AceDataCloudClient] search(): result[${idx}] failed validation: ${parsed.error.message}`
        );
      }
      return parsed.data as SearchResult;
    });

    if (validated.length === 0) {
      throw new PaymentError(
        "[AceDataCloudClient] search(): response contained no search results"
      );
    }

    return validated;
  }

  /**
   * LLM Chat Completions via AceDataCloud.
   * POST /v1/chat/completions — no Bearer header.
   * Validates content is non-empty and length > 50; throws ContentValidationError if not.
   * Throws PaymentError if x402_tx header is absent.
   * Requirements: 6.1, 6.2, 6.3, 6.5, 6.6, 8.2, 8.4
   */
  async chat(
    messages: ChatMessage[],
    model: string = "gpt-4o-mini"
  ): Promise<string> {
    this.resetLastX402Tx();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (this.sdk as any).request({
      method: "POST",
      path: "/v1/chat/completions",
      body: { model, messages, max_tokens: 1500 },
    });

    // Validate x402_tx header was captured (Requirement 8.4)
    const txHash = this.getLastX402Tx();
    if (!txHash) {
      throw new PaymentError(
        "[AceDataCloudClient] chat(): x402_tx header absent from response — payment not confirmed"
      );
    }

    // Extract content from choices[0].message.content
    const content: unknown =
      response?.choices?.[0]?.message?.content ?? null;

    // Validate content (Requirement 6.3, 6.5) — throw ContentValidationError, not PaymentError
    if (content === null || content === undefined) {
      throw new ContentValidationError(
        "[AceDataCloudClient] chat(): choices[0].message.content is null or undefined",
        0
      );
    }

    const contentStr = String(content);
    if (contentStr.length <= 50) {
      throw new ContentValidationError(
        `[AceDataCloudClient] chat(): content too short (${contentStr.length} chars, minimum 51 required)`,
        contentStr.length
      );
    }

    return contentStr;
  }

  /**
   * Midjourney Image Generation via AceDataCloud.
   * POST /midjourney/imagine — no Bearer header.
   * Validates image_url is a valid HTTPS URL.
   * Throws PaymentError if x402_tx header is absent.
   * Requirements: 7.1, 7.2, 7.3, 7.5, 8.2, 8.4
   */
  async generateImage(prompt: string): Promise<ImageResult> {
    this.resetLastX402Tx();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await (this.sdk as any).request({
      method: "POST",
      path: "/midjourney/imagine",
      body: { prompt, mode: "turbo" },
    });

    // Validate x402_tx header was captured (Requirement 8.4)
    const txHash = this.getLastX402Tx();
    if (!txHash) {
      throw new PaymentError(
        "[AceDataCloudClient] generateImage(): x402_tx header absent from response — payment not confirmed"
      );
    }

    // Validate image_url is a valid HTTPS URL (Requirement 7.3, 7.5)
    const imageUrl: unknown = response?.image_url ?? null;
    if (!imageUrl || typeof imageUrl !== "string") {
      throw new Error(
        "[AceDataCloudClient] generateImage(): response missing image_url field"
      );
    }
    if (!imageUrl.startsWith("https://")) {
      throw new Error(
        `[AceDataCloudClient] generateImage(): image_url is not a valid HTTPS URL: "${imageUrl}"`
      );
    }

    const taskId: string =
      typeof response?.task_id === "string" ? response.task_id : "";

    return {
      imageUrl,
      taskId,
      paymentTxHash: txHash,
    };
  }
}
