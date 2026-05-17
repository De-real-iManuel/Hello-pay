/**
 * CLI entry point for the Autonomous Bounty Agent.
 *
 * Usage:
 *   npx tsx src/index.ts "<topic>"
 *   npx tsx src/index.ts "DeFi yield strategies Q3 2026"
 *
 * If no topic argument is provided, defaults to "DeFi yield strategies Q3 2026".
 *
 * Requirements: 11.2, 11.3
 */

import { loadConfig } from "./config.js";
import { BountyAgent } from "./agent/BountyAgent.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = new BountyAgent(config);

  try {
    await agent.initialize();

    const topic = process.argv[2] ?? "DeFi yield strategies Q3 2026";
    console.log(`[BountyAgent] Starting pipeline for topic: "${topic}"`);

    const brief = await agent.run(topic);

    // Log all required output fields (Requirement 11.3)
    console.log("\n=== Research Brief ===");
    console.log(`Topic:     ${brief.topic}`);
    console.log(`SOL Price: $${brief.solPrice} (via Synapse Sentinel / Pyth)`);
    console.log(`Analysis:  ${brief.analysis.slice(0, 200)}...`);
    console.log(`Image:     ${brief.imageUrl}`);
    console.log(`\nPayments (${brief.payments.length} x402 settlements):`);
    for (const p of brief.payments) {
      console.log(`  [${p.service}] ${p.amountUsdc} USDC — tx: ${p.txHash}`);
    }
    console.log(`\nOn-chain ledger TX: ${brief.onChain.ledgerTx}`);
    console.log(`Content hash:       ${brief.onChain.contentHash}`);
  } finally {
    await agent.shutdown();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
