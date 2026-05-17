/**
 * Property-based tests for ResultPersister.
 *
 * Property 7: On-Chain Content Hash Integrity
 * For any ResearchBrief, sha256(JSON.stringify(brief)) === brief.onChain.contentHash
 * and brief.onChain.ledgerTx is a non-empty string of 87–88 base58 characters.
 *
 * Validates: Requirements 10.4, 15.8
 */

import { describe, it, expect, vi } from "vitest";
import * as fc from "fast-check";
import { createHash } from "crypto";
import { ResultPersister } from "../../src/agent/ResultPersister.js";
import type { ResearchBrief } from "../../src/types/index.js";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const nonEmptyStringArb = fc.string({ minLength: 1, maxLength: 40 }).filter(
  (s) => s.trim().length > 0
);

const uuidArb = fc.uuid();

const positiveNumberArb = fc.float({ min: Math.fround(0.01), max: Math.fround(1000), noNaN: true });

const searchResultArb = fc.record({
  title: nonEmptyStringArb,
  url: nonEmptyStringArb,
  snippet: nonEmptyStringArb,
});

const paymentRecordArb = fc.record({
  service: fc.constantFrom(
    "sentinel" as const,
    "acedata-search" as const,
    "acedata-llm" as const,
    "acedata-image" as const
  ),
  network: fc.constant("solana" as const),
  amountUsdc: fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true }).map((n) => n.toFixed(6)),
  txHash: nonEmptyStringArb,
  settledAt: fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }),
});

const researchBriefArb = fc.record({
  id: uuidArb,
  topic: nonEmptyStringArb,
  createdAt: fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }),
  solPrice: positiveNumberArb,
  searchResults: fc.array(searchResultArb, { minLength: 1, maxLength: 2 }),
  analysis: fc.string({ minLength: 51, maxLength: 200 }),
  imageUrl: fc.constant("https://cdn.midjourney.com/test.png"),
  payments: fc.array(paymentRecordArb, { minLength: 4, maxLength: 4 }),
  onChain: fc.record({
    ledgerTx: fc.constant(""),
    contentHash: fc.constant(""),
    agentPda: nonEmptyStringArb,
  }),
});

// Base58 character set
const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Generate a realistic Solana TX signature (87–88 base58 chars) */
function makeSolanaTx(length: 87 | 88): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result += BASE58_CHARS[Math.floor(Math.random() * BASE58_CHARS.length)];
  }
  return result;
}

const solanaTxArb = fc.constantFrom(87 as const, 88 as const).map(makeSolanaTx);

// ---------------------------------------------------------------------------
// Property 7: On-Chain Content Hash Integrity
// ---------------------------------------------------------------------------

describe("Property 7: On-Chain Content Hash Integrity", () => {
  it(
    "Validates Req 10.4, 15.8 — sha256(JSON.stringify(brief)) === contentHash in LedgerEntry",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          researchBriefArb,
          solanaTxArb,
          async (brief: ResearchBrief, txSig: string) => {
            const agentPda = brief.onChain.agentPda;

            // Mock client that returns the generated TX signature
            const mockClient = {
              ledger: {
                append: vi.fn().mockResolvedValue(txSig),
              },
            };

            const persister = new ResultPersister(mockClient, agentPda);
            const entry = await persister.persist(brief);

            // Property: contentHash === sha256(JSON.stringify(brief))
            const expectedHash = createHash("sha256")
              .update(JSON.stringify(brief), "utf8")
              .digest("hex");
            expect(entry.contentHash).toBe(expectedHash);

            // Property: ledgerTx is non-empty (Req 15.8)
            expect(entry.tx.length).toBeGreaterThan(0);

            // Property: ledgerTx matches the TX returned by the SDK
            expect(entry.tx).toBe(txSig);

            // Property: agentPda is preserved
            expect(entry.agentPda).toBe(agentPda);
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    "Validates Req 10.4 — contentHash is deterministic for the same brief",
    async () => {
      await fc.assert(
        fc.asyncProperty(researchBriefArb, async (brief: ResearchBrief) => {
          const mockClient = {
            ledger: {
              append: vi.fn().mockResolvedValue("tx-deterministic"),
            },
          };

          const persister = new ResultPersister(mockClient, brief.onChain.agentPda);

          // Persist twice with the same brief
          const entry1 = await persister.persist(brief);
          const entry2 = await persister.persist(brief);

          // Content hash must be identical for the same brief
          expect(entry1.contentHash).toBe(entry2.contentHash);
        }),
        { numRuns: 5 }
      );
    }
  );

  it(
    "Validates Req 10.4 — different briefs produce different content hashes",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          researchBriefArb,
          researchBriefArb,
          async (brief1: ResearchBrief, brief2: ResearchBrief) => {
            // Only test when briefs are actually different
            fc.pre(JSON.stringify(brief1) !== JSON.stringify(brief2));

            const hash1 = createHash("sha256")
              .update(JSON.stringify(brief1), "utf8")
              .digest("hex");
            const hash2 = createHash("sha256")
              .update(JSON.stringify(brief2), "utf8")
              .digest("hex");

            expect(hash1).not.toBe(hash2);
          }
        ),
        { numRuns: 5 }
      );
    }
  );

  it(
    "Validates Req 15.8 — ledgerTx from a real Solana TX is 87–88 base58 characters",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          researchBriefArb,
          solanaTxArb,
          async (brief: ResearchBrief, txSig: string) => {
            // Verify the TX signature length is 87 or 88 (Solana base58 signatures)
            expect(txSig.length).toBeGreaterThanOrEqual(87);
            expect(txSig.length).toBeLessThanOrEqual(88);

            // Verify all characters are valid base58
            for (const char of txSig) {
              expect(BASE58_CHARS).toContain(char);
            }

            const mockClient = {
              ledger: {
                append: vi.fn().mockResolvedValue(txSig),
              },
            };

            const persister = new ResultPersister(mockClient, brief.onChain.agentPda);
            const entry = await persister.persist(brief);

            expect(entry.tx).toBe(txSig);
            expect(entry.tx.length).toBeGreaterThanOrEqual(87);
            expect(entry.tx.length).toBeLessThanOrEqual(88);
          }
        ),
        { numRuns: 5 }
      );
    }
  );
});
