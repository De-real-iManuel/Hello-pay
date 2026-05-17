# Hello-pay — Autonomous Bounty Agent

An autonomous on-chain AI research agent built on Solana. Given a topic, it discovers tools via the Synapse Agent Protocol (SAP), fetches a live SOL price from the Pyth oracle, runs a full web search → LLM analysis → image generation pipeline, settles every API call with x402 USDC micropayments, and writes the final research brief to an on-chain ledger — all without human intervention.

Built for the [OOBE Protocol × Ace Data Cloud joint bounty](https://www.oobeprotocol.ai/).

---

## How It Works

```
trigger → discover tools (SAP) → get SOL price (Sentinel/Pyth)
       → web search (AceDataCloud) → LLM analysis (AceDataCloud)
       → image generation (AceDataCloud) → persist to ledger (SAP)
```

Each step pays for itself via x402 USDC micropayments. No manual input at any stage.

---

## Pipeline Stages

### 1. Initialize
- Loads the Solana keypair from `wallet.json`
- Connects to the Synapse RPC via `SOLANA_RPC_URL`
- Checks wallet balances (min 0.015 SOL, min 0.5 USDC)
- Registers the agent on SAP mainnet (idempotent — skips if already active)

### 2. Discovery
- Queries SAP capability indexes for `synapse-agent-kit:gateway`
- Locates the Synapse Sentinel agent by its known wallet address
- Verifies Sentinel is active and has an x402 endpoint configured

### 3. Sentinel (SOL/USD Price)
- Prepares an x402 escrow payment to the Sentinel agent via SAP
- POSTs to Sentinel's `/tools/get_price` endpoint with `{ asset: "SOL/USD" }`
- Returns a live Pyth oracle price with confidence interval and settlement TX

### 4. Web Search
- POSTs to AceDataCloud `/search` with the research topic
- Payment handled automatically via the x402 402→sign→retry cycle
- Returns up to 10 search results (title, URL, snippet)

### 5. LLM Analysis
- Builds a structured prompt from the topic, search results, and SOL price
- POSTs to AceDataCloud `/v1/chat/completions` using `gpt-4o-mini`
- Returns a 200+ word research analysis

### 6. Image Generation
- Builds a Midjourney-style prompt from the topic and analysis
- POSTs to AceDataCloud `/midjourney/imagine` in turbo mode
- Returns a valid HTTPS image URL

### 7. Persist to Ledger
- Serialises the full `ResearchBrief` to JSON
- Computes a SHA-256 content hash
- Appends to the SAP LedgerModule for on-chain auditability
- Returns the confirmed Solana TX signature

---

## Output

A successful run prints and returns a `ResearchBrief`:

```
=== Research Brief ===
Topic:     DeFi yield strategies Q3 2026
SOL Price: $148.32 (via Synapse Sentinel / Pyth)
Analysis:  DeFi protocols on Solana have seen...
Image:     https://cdn.midjourney.com/...

Payments (4 x402 settlements):
  [sentinel]       0.02     USDC — tx: 5xK...
  [acedata-search] 0.095215 USDC — tx: 3mP...
  [acedata-llm]    0.095215 USDC — tx: 9nQ...
  [acedata-image]  0.095215 USDC — tx: 2rT...

On-chain ledger TX: 7vW...
Content hash:       a3f9b2...
```

---

## Project Structure

```
src/
├── index.ts                  # CLI entry point
├── config.ts                 # Env var loading and validation (Zod)
├── types/
│   └── index.ts              # All shared TypeScript interfaces
├── agent/
│   ├── BountyAgent.ts        # Top-level pipeline orchestrator
│   ├── SapRegistrar.ts       # SAP agent registration lifecycle
│   ├── ToolDiscovery.ts      # SAP capability index queries
│   ├── SentinelClient.ts     # Pyth price via Synapse Sentinel + x402
│   ├── AceDataCloudClient.ts # Web search, LLM, image gen + x402
│   └── ResultPersister.ts    # SAP LedgerModule write + history query
└── utils/
    ├── keypair.ts            # Safe Solana keypair loading
    ├── retry.ts              # Exponential backoff with jitter
    └── errors.ts             # Typed custom error classes
```

---

## Prerequisites

| Requirement | Details |
|---|---|
| Node.js | v18 or later |
| Solana CLI | For keypair generation (`solana-keygen`) |
| Solana wallet | Funded with SOL and USDC on mainnet |
| Synapse RPC key | Free tier at [synapse.oobeprotocol.ai](https://synapse.oobeprotocol.ai) |
| AceDataCloud account | Free credits on signup at [platform.acedata.cloud](https://platform.acedata.cloud) |

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/De-real-iManuel/Hello-pay.git
cd Hello-pay
npm install
```

### 2. Generate a wallet

```bash
solana-keygen new --outfile wallet.json
```

> **Never commit `wallet.json`.** It is already in `.gitignore`.

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
# Synapse/OOBE Protocol API key — get from synapse.oobeprotocol.ai
SYNAPSE_API_KEY=sk_live_...

# Solana RPC endpoint with your Synapse API key
SOLANA_RPC_URL=https://us-1-mainnet.oobeprotocol.ai/rpc?api_key=sk_live_...

# Path to your generated keypair
WALLET_KEYPAIR_PATH=./wallet.json

# AceDataCloud API key — get from platform.acedata.cloud
ACEDATA_API_KEY=your_acedata_key

# These have sensible defaults — only change if needed
ACEDATA_BASE_URL=https://api.acedata.cloud
FACILITATOR_URL=https://facilitator.acedata.cloud
USDC_MINT=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
NETWORK=solana
```

### 4. Fund your wallet

Your wallet needs:
- **≥ 0.015 SOL** for transaction fees (more for SAP registration)
- **≥ 0.5 USDC** for API micropayments (~$0.38 per full run)

Send SOL and USDC to the public key printed by:
```bash
solana-keygen pubkey wallet.json
```

### 5. Run

```bash
npm start
# or with a custom topic:
npx tsx src/index.ts "Solana DeFi protocols Q3 2026"
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOLANA_RPC_URL` | ✅ | — | Solana mainnet RPC endpoint |
| `WALLET_KEYPAIR_PATH` | ✅ | — | Path to the 64-byte keypair JSON |
| `SYNAPSE_API_KEY` | ✅ | — | OOBE Protocol API key |
| `ACEDATA_API_KEY` | ✅ | — | AceDataCloud API key |
| `ACEDATA_BASE_URL` | ❌ | `https://api.acedata.cloud` | AceDataCloud base URL |
| `FACILITATOR_URL` | ❌ | `https://facilitator.acedata.cloud` | x402 facilitator URL |
| `USDC_MINT` | ❌ | `EPjFWdd5...` | USDC SPL token mint address |
| `NETWORK` | ❌ | `solana` | Settlement network (`solana` or `base`) |

---

## Error Reference

| Error | Code | Retryable | Cause |
|---|---|---|---|
| `ConfigurationError` | `CONFIGURATION_ERROR` | — | Missing required env vars |
| `InvalidKeypairError` | `INVALID_KEYPAIR` | — | Bad or missing `wallet.json` |
| `InsufficientSolError` | `INSUFFICIENT_SOL` | ❌ | SOL balance below 0.015 |
| `InsufficientUsdcError` | `INSUFFICIENT_USDC` | ❌ | USDC balance below 0.5 |
| `InsufficientFundsError` | `INSUFFICIENT_FUNDS` | ❌ | Not enough USDC for a payment |
| `PaymentError` | `PAYMENT_ERROR` | ❌ | x402 handshake failed |
| `ContentValidationError` | `CONTENT_VALIDATION_ERROR` | ❌ | LLM response too short or null |
| `RegistrationError` | `REGISTRATION_ERROR` | ❌ | SAP registration failed |
| `DuplicateRunError` | `DUPLICATE_RUN` | ❌ | Same topic already running |
| `ImageGenerationTimeoutError` | `IMAGE_GENERATION_TIMEOUT` | ✅ | Midjourney timed out |

Transient network errors (5xx, timeouts) are retried up to 3 times with exponential backoff (500ms base, 8s max, ±20% jitter).

---

## Development

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Property-based tests only
npm run test:property

# TypeScript build check
npm run build
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js + TypeScript (ESM) |
| Blockchain | Solana (web3.js) |
| Agent Protocol | [Synapse Agent Protocol (SAP)](https://explorer.oobeprotocol.ai/docs) |
| AI Services | [Ace Data Cloud](https://platform.acedata.cloud) |
| Payments | x402 USDC micropayments |
| Price Oracle | Pyth via [Synapse Sentinel](https://explorer.oobeprotocol.ai/agents/Ccr2yK3hLALU4p8oNRqrh4dGuvPJTth5KCLMio8cE1ph) |
| Validation | Zod |
| Testing | Vitest + fast-check (property-based) |

---

## Security

- `wallet.json` and `.env` are gitignored and must never be committed
- Error messages never expose raw key bytes
- All secrets are loaded from environment variables only
- The keypair file is validated (64-byte array, all values 0–255) before use

---

## License

MIT — see [LICENSE](./LICENSE)
