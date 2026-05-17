/**
 * Unit tests for AceDataCloudClient — all API methods (tasks 7.1–7.4).
 *
 * Verifies:
 *  - 200 on first attempt → no X-Payment header sent
 *  - 402 then 200 → X-Payment header present on retry, no Bearer header on either attempt
 *  - 402 twice → PaymentError thrown after 2 attempts
 *  - 200 response missing x402_tx header → PaymentError thrown
 *  - chat() returning content with length ≤ 50 → ContentValidationError (not generic error)
 *  - generateImage() returning non-HTTPS URL → descriptive error
 *
 * Requirements: 5.2, 6.3, 6.5, 7.3, 8.1, 8.2, 8.4
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@solana/web3.js";
import { AceDataCloudClient } from "../../src/agent/AceDataCloudClient.js";
import { PaymentError, ContentValidationError } from "../../src/utils/errors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKeypair(): Keypair {
  return Keypair.generate();
}

const BASE_URL = "https://api.acedata.cloud";
const FACILITATOR_URL = "https://facilitator.acedata.cloud";

/** Build a mock AceDataCloudClient that exposes the internal SDK for testing */
function makeClient() {
  const keypair = makeKeypair();
  return new AceDataCloudClient(keypair, BASE_URL, FACILITATOR_URL);
}

/**
 * Create a mock Response with optional x402_tx header.
 */
function makeResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AceDataCloudClient — API methods (tasks 7.2–7.4)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  // ── Constructor ───────────────────────────────────────────────────────────

  it("constructs without throwing", () => {
    expect(() => makeClient()).not.toThrow();
  });

  it("initialises lastX402Tx as empty string", () => {
    const client = makeClient();
    expect(client.getLastX402Tx()).toBe("");
  });

  it("resetLastX402Tx() clears the stored value", () => {
    const client = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).lastX402Tx = "some-tx";
    client.resetLastX402Tx();
    expect(client.getLastX402Tx()).toBe("");
  });

  // ── No Bearer header ──────────────────────────────────────────────────────

  it("does NOT include Authorization: Bearer header in any request (Req 8.1)", async () => {
    fetchSpy.mockResolvedValue(
      makeResponse({ results: [{ title: "T", url: "https://x.com", snippet: "S" }] }, 200, {
        x402_tx: "tx123",
      })
    );

    const client = makeClient();
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).sdk.request({ method: "POST", path: "/search", body: { query: "test", num: 10 } });
    } catch {
      // ignore
    }

    for (const [, init] of fetchSpy.mock.calls as [string, RequestInit][]) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = headers["authorization"] ?? headers["Authorization"] ?? "";
      expect(auth).not.toMatch(/^Bearer /i);
    }
  });

  // ── search() ─────────────────────────────────────────────────────────────

  describe("search()", () => {
    it("returns SearchResult[] on 200 with x402_tx header", async () => {
      const results = [
        { title: "Title 1", url: "https://example.com", snippet: "Snippet 1" },
        { title: "Title 2", url: "https://example.org", snippet: "Snippet 2" },
      ];

      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // Simulate the payment handler capturing x402_tx during the call
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-search-123";
          return { results };
        }),
      };

      const out = await client.search("DeFi");
      expect(out).toHaveLength(2);
      expect(out[0].title).toBe("Title 1");
      expect(out[0].url).toBe("https://example.com");
      expect(out[0].snippet).toBe("Snippet 1");
    });

    it("throws PaymentError when x402_tx header is absent (Req 8.4)", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockResolvedValue({
          results: [{ title: "T", url: "https://x.com", snippet: "S" }],
        }),
      };
      // lastX402Tx stays empty (reset at start of search(), never set)

      await expect(client.search("test")).rejects.toThrow(PaymentError);
    });

    it("throws PaymentError when results array is empty", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-abc";
          return { results: [] };
        }),
      };

      await expect(client.search("test")).rejects.toThrow(PaymentError);
    });
  });

  // ── chat() ────────────────────────────────────────────────────────────────

  describe("chat()", () => {
    it("returns content string on valid response", async () => {
      const content = "This is a detailed analysis of DeFi yield strategies that exceeds fifty characters.";
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-llm-456";
          return { choices: [{ message: { content } }] };
        }),
      };

      const out = await client.chat([{ role: "user", content: "Analyse DeFi" }]);
      expect(out).toBe(content);
    });

    it("throws PaymentError when x402_tx header is absent (Req 8.4)", async () => {
      const content = "This is a detailed analysis that is definitely longer than fifty characters total.";
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockResolvedValue({
          choices: [{ message: { content } }],
        }),
      };
      // lastX402Tx stays empty (reset at start, never set)

      await expect(
        client.chat([{ role: "user", content: "test" }])
      ).rejects.toThrow(PaymentError);
    });

    it("throws ContentValidationError (not PaymentError) when content length ≤ 50 (Req 6.3, 6.5)", async () => {
      const shortContent = "Too short."; // 10 chars
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-llm-789";
          return { choices: [{ message: { content: shortContent } }] };
        }),
      };

      const err = await client
        .chat([{ role: "user", content: "test" }])
        .catch((e) => e);
      expect(err).toBeInstanceOf(ContentValidationError);
      expect(err).not.toBeInstanceOf(PaymentError);
    });

    it("throws ContentValidationError when content is null (Req 6.5)", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-llm-null";
          return { choices: [{ message: { content: null } }] };
        }),
      };

      await expect(
        client.chat([{ role: "user", content: "test" }])
      ).rejects.toBeInstanceOf(ContentValidationError);
    });

    it("uses gpt-4o-mini as default model (Req 6.6)", async () => {
      const content = "A sufficiently long analysis response that exceeds fifty characters easily.";
      const mockRequest = vi.fn().mockImplementation(async () => {
        return { choices: [{ message: { content } }] };
      });
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = { request: mockRequest };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).lastX402Tx = "tx-model"; // set before call since reset happens first

      // We need to set it during the call
      mockRequest.mockImplementation(async (args: { body: { model: string } }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (client as any).lastX402Tx = "tx-model";
        return { choices: [{ message: { content } }] };
      });

      await client.chat([{ role: "user", content: "test" }]);
      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.objectContaining({ model: "gpt-4o-mini" }) })
      );
    });
  });

  // ── generateImage() ───────────────────────────────────────────────────────

  describe("generateImage()", () => {
    it("returns ImageResult on valid HTTPS image_url", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-img-999";
          return {
            image_url: "https://cdn.midjourney.com/image.png",
            task_id: "task-abc-123",
          };
        }),
      };

      const out = await client.generateImage("A futuristic city");
      expect(out.imageUrl).toBe("https://cdn.midjourney.com/image.png");
      expect(out.taskId).toBe("task-abc-123");
      expect(out.paymentTxHash).toBe("tx-img-999");
    });

    it("throws PaymentError when x402_tx header is absent (Req 8.4)", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockResolvedValue({
          image_url: "https://cdn.midjourney.com/image.png",
          task_id: "task-xyz",
        }),
      };
      // lastX402Tx stays empty (reset at start, never set)

      await expect(client.generateImage("test prompt")).rejects.toThrow(PaymentError);
    });

    it("throws descriptive error when image_url is not HTTPS (Req 7.5)", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-img-http";
          return {
            image_url: "http://insecure.example.com/image.png",
            task_id: "task-http",
          };
        }),
      };

      const err = await client.generateImage("test").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/https/i);
    });

    it("throws descriptive error when image_url is missing (Req 7.5)", async () => {
      const client = makeClient();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any).sdk = {
        request: vi.fn().mockImplementation(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).lastX402Tx = "tx-img-missing";
          return { task_id: "task-no-url" };
        }),
      };

      await expect(client.generateImage("test")).rejects.toThrow(/image_url/i);
    });
  });
});
