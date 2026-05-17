/**
 * Unit tests for ResultPersister in src/agent/ResultPersister.ts
 *
 * Verifies:
 *  - SHA-256(JSON.stringify(brief)) === contentHash in the appended payload
 *  - Ledger failure → descriptive error thrown and no brief returned
 *  - fetchHistory() delegates to client.ledger.query with correct limit
 *
 * Requirements: 10.1, 10.4, 10.5
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";
import { ResultPersister } from "../../src/agent/ResultPersister.js";
import type { ResearchBrief } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_PDA = "AgentPDA1111111111111111111111111111111111111";

function makeBrief(overrides: Partial<ResearchBrief> = {}): ResearchBrief {
  return {
    id: "550e8400-e29b-41d4-a716-446655440000",
    topic: "DeFi yield strategies",
    createdAt: 1700000000,
    solPrice: 185.42,
    searchResults: [
      { title: "DeFi Guide", url: "https://example.com", snippet: "A guide to DeFi" },
    ],
    analysis: "A comprehensive analysis of DeFi yield strategies for Q3 2026.",
    imageUrl: "https://cdn.midjourney.com/image.png",
    payments: [
      { service: "sentinel", network: "solana", amountUsdc: "0.02", txHash: "tx1", settledAt: 1700000001 },
      { service: "acedata-search", network: "solana", amountUsdc: "0.095", txHash: "tx2", settledAt: 1700000002 },
      { service: "acedata-llm", network: "solana", amountUsdc: "0.095", txHash: "tx3", settledAt: 1700000003 },
      { service: "acedata-image", network: "solana", amountUsdc: "0.095", txHash: "tx4", settledAt: 1700000004 },
    ],
    onChain: {
      ledgerTx: "",
      contentHash: "",
      agentPda: AGENT_PDA,
    },
    ...overrides,
  };
}

function makeMockClient(overrides: {
  appendResult?: unknown;
  appendThrows?: Error;
  queryResult?: unknown[];
  queryThrows?: Error;
} = {}) {
  return {
    ledger: {
      append: overrides.appendThrows
        ? vi.fn().mockRejectedValue(overrides.appendThrows)
        : vi.fn().mockResolvedValue(overrides.appendResult ?? "confirmed-tx-sig-123"),
      query: overrides.queryThrows
        ? vi.fn().mockRejectedValue(overrides.queryThrows)
        : vi.fn().mockResolvedValue(overrides.queryResult ?? []),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ResultPersister", () => {
  // ── persist() ─────────────────────────────────────────────────────────────

  describe("persist()", () => {
    it("calls ledger.append with correct data and contentHash", async () => {
      const brief = makeBrief();
      const client = makeMockClient();
      const persister = new ResultPersister(client, AGENT_PDA);

      await persister.persist(brief);

      expect(client.ledger.append).toHaveBeenCalledOnce();
      const [payload] = client.ledger.append.mock.calls[0] as [{ data: string; contentHash: string }][];

      // Verify data is JSON-serialised brief
      expect(payload.data).toBe(JSON.stringify(brief));

      // Verify contentHash === SHA-256(JSON.stringify(brief)) (Req 10.4)
      const expectedHash = createHash("sha256")
        .update(JSON.stringify(brief), "utf8")
        .digest("hex");
      expect(payload.contentHash).toBe(expectedHash);
    });

    it("returns LedgerEntry with tx, contentHash, and agentPda", async () => {
      const brief = makeBrief();
      const client = makeMockClient({ appendResult: "tx-sig-abc123" });
      const persister = new ResultPersister(client, AGENT_PDA);

      const entry = await persister.persist(brief);

      expect(entry.tx).toBe("tx-sig-abc123");
      expect(entry.agentPda).toBe(AGENT_PDA);
      expect(entry.contentHash).toBe(
        createHash("sha256").update(JSON.stringify(brief), "utf8").digest("hex")
      );
    });

    it("returns LedgerEntry when SDK returns { tx: string } object", async () => {
      const brief = makeBrief();
      const client = makeMockClient({ appendResult: { tx: "tx-from-object" } });
      const persister = new ResultPersister(client, AGENT_PDA);

      const entry = await persister.persist(brief);
      expect(entry.tx).toBe("tx-from-object");
    });

    it("throws descriptive error when ledger.append fails (Req 10.5)", async () => {
      const brief = makeBrief();
      const client = makeMockClient({
        appendThrows: new Error("Ledger transaction rejected: insufficient rent"),
      });
      const persister = new ResultPersister(client, AGENT_PDA);

      await expect(persister.persist(brief)).rejects.toThrow(
        /Ledger append failed.*insufficient rent/i
      );
    });

    it("does NOT return a brief when ledger append fails (Req 10.5)", async () => {
      const brief = makeBrief();
      const client = makeMockClient({ appendThrows: new Error("Network error") });
      const persister = new ResultPersister(client, AGENT_PDA);

      let result: unknown = undefined;
      try {
        result = await persister.persist(brief);
      } catch {
        // expected
      }

      expect(result).toBeUndefined();
    });

    it("throws when ledger.append returns empty string (no TX)", async () => {
      const brief = makeBrief();
      const client = makeMockClient({ appendResult: "" });
      const persister = new ResultPersister(client, AGENT_PDA);

      await expect(persister.persist(brief)).rejects.toThrow(
        /no transaction signature/i
      );
    });
  });

  // ── fetchHistory() ────────────────────────────────────────────────────────

  describe("fetchHistory()", () => {
    it("delegates to client.ledger.query with the specified limit (Req 10.6)", async () => {
      const client = makeMockClient({ queryResult: [] });
      const persister = new ResultPersister(client, AGENT_PDA);

      await persister.fetchHistory(5);

      expect(client.ledger.query).toHaveBeenCalledWith({ limit: 5 });
    });

    it("uses default limit of 10 when no limit is specified", async () => {
      const client = makeMockClient({ queryResult: [] });
      const persister = new ResultPersister(client, AGENT_PDA);

      await persister.fetchHistory();

      expect(client.ledger.query).toHaveBeenCalledWith({ limit: 10 });
    });

    it("returns mapped LedgerEntry[] from query results", async () => {
      const rawEntries = [
        { tx: "tx-hist-1", contentHash: "hash1", agentPda: AGENT_PDA },
        { tx: "tx-hist-2", contentHash: "hash2", agentPda: AGENT_PDA },
      ];
      const client = makeMockClient({ queryResult: rawEntries });
      const persister = new ResultPersister(client, AGENT_PDA);

      const history = await persister.fetchHistory(2);

      expect(history).toHaveLength(2);
      expect(history[0].tx).toBe("tx-hist-1");
      expect(history[1].tx).toBe("tx-hist-2");
    });

    it("returns empty array when query returns no results", async () => {
      const client = makeMockClient({ queryResult: [] });
      const persister = new ResultPersister(client, AGENT_PDA);

      const history = await persister.fetchHistory();
      expect(history).toEqual([]);
    });

    it("throws descriptive error when query fails", async () => {
      const client = makeMockClient({ queryThrows: new Error("RPC timeout") });
      const persister = new ResultPersister(client, AGENT_PDA);

      await expect(persister.fetchHistory()).rejects.toThrow(/fetchHistory failed.*RPC timeout/i);
    });
  });
});
