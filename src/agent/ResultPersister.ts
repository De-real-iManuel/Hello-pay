/**
 * ResultPersister — writes the final ResearchBrief to the SAP LedgerModule
 * for on-chain auditability.
 *
 * Responsibilities:
 *  - persist(brief): serialise to JSON, compute SHA-256, call ledger.append()
 *  - fetchHistory(limit?): query SAP LedgerModule for previous entries
 *
 * Requirements: 10.1, 10.2, 10.3, 10.5, 10.6
 */

import { createHash } from "crypto";
import type { ResearchBrief, LedgerEntry } from "../types/index.js";

export class ResultPersister {
  /**
   * @param client   - High-level SapClient from SapConnection.fromKeypair()
   * @param agentPda - The agent's PDA address (base58 string)
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private readonly client: any, private readonly agentPda: string) {}

  // -------------------------------------------------------------------------
  // persist
  // -------------------------------------------------------------------------

  /**
   * Serialise the ResearchBrief to JSON, compute its SHA-256 content hash,
   * and append it to the SAP LedgerModule.
   *
   * Returns a LedgerEntry with the confirmed Solana TX signature, content hash,
   * and agent PDA address.
   *
   * Throws a descriptive error if the ledger append transaction fails.
   * Does NOT return a partial result — if the TX is not confirmed, throws.
   *
   * Requirements: 10.1, 10.2, 10.3, 10.5
   */
  async persist(brief: ResearchBrief): Promise<LedgerEntry> {
    // Step 1: Serialise to JSON (Requirement 10.1)
    const serialised = JSON.stringify(brief);

    // Step 2: Compute SHA-256 content hash (Requirement 10.1, 10.4)
    const contentHash = createHash("sha256")
      .update(serialised, "utf8")
      .digest("hex");

    // Step 3: Append to SAP LedgerModule (Requirement 10.1)
    let tx: string;
    try {
      const result = await this.client.ledger.append({
        data: serialised,
        contentHash,
      });

      // The SDK may return the TX signature directly or wrapped in an object
      if (typeof result === "string") {
        tx = result;
      } else if (result && typeof result.tx === "string") {
        tx = result.tx;
      } else if (result && typeof result.signature === "string") {
        tx = result.signature;
      } else {
        tx = String(result ?? "");
      }
    } catch (err) {
      throw new Error(
        `[ResultPersister] Ledger append failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    // Step 4: Validate we have a confirmed TX (Requirement 10.5)
    if (!tx) {
      throw new Error(
        "[ResultPersister] Ledger append returned no transaction signature — brief not persisted"
      );
    }

    // Step 5: Return LedgerEntry (Requirement 10.2)
    return {
      tx,
      contentHash,
      agentPda: this.agentPda,
    };
  }

  // -------------------------------------------------------------------------
  // fetchHistory
  // -------------------------------------------------------------------------

  /**
   * Query the SAP LedgerModule and return up to `limit` previous LedgerEntry
   * records for this agent's PDA.
   *
   * Requirements: 10.6
   */
  async fetchHistory(limit?: number): Promise<LedgerEntry[]> {
    const queryLimit = limit ?? 10;

    let raw: unknown[];
    try {
      raw = await this.client.ledger.query({ limit: queryLimit });
    } catch (err) {
      throw new Error(
        `[ResultPersister] fetchHistory failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    if (!Array.isArray(raw)) {
      return [];
    }

    return raw.map((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      return {
        tx: typeof e.tx === "string" ? e.tx : String(e.tx ?? ""),
        contentHash:
          typeof e.contentHash === "string"
            ? e.contentHash
            : String(e.contentHash ?? ""),
        agentPda:
          typeof e.agentPda === "string"
            ? e.agentPda
            : this.agentPda,
      };
    });
  }
}
