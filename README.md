# VIEWER — Autonomous Onchain Intelligence

> AI-generated wallet intelligence reports, authenticated via ERC-8128, stored on Filecoin, built on Base, with gasless deployment on Status Network.

VIEWER lets anyone paste an Ethereum wallet address, sign a request with MetaMask (authenticated via the Slice ERC-8128 standard), and receive a full AI-generated intelligence report — transaction history, portfolio breakdown, DeFi activity, risk flags, counterparty map, and a 1–10 trust score. Each report is stored permanently on Filecoin via Pinata IPFS.



Live Demo: https://viewerr.up.railway.app/
Video Demo: https://www.youtube.com/watch?v=DBlCh_a_mvM

```
```



## How It Works

```
1. Visit → paste any wallet address
2. Pay $0.50 USDC via x402 on Base Sepolia (MetaMask EIP-3009 signature)
3. Authenticate via ERC-8128 — sign the RFC 9421 request with MetaMask
4. Server verifies payment (x402 facilitator) + identity (Slice SDK verifyRequest)
5. Agent fetches wallet data from Base Mainnet (6 parallel Alchemy calls)
6. Groq LLaMA-3.3-70b writes the intelligence report
7. Report stored permanently on Filecoin via Pinata IPFS
8. Gasless proof tx fired on Status Network Sepolia (per report, non-blocking)
9. Buyer receives report + Filecoin link + Status Network receipt
```

---

## Architecture

```
Browser (MetaMask)
    │
    ├─ eth_signTypedData_v4 ──→ x402 USDC payment (EIP-3009)
    ├─ personal_sign ─────────→ ERC-8128 HTTP auth (RFC 9421)
    │
    ▼
POST /analyze-signed
    │
    ├─ x402 middleware ───────→ Coinbase facilitator verifies USDC payment on Base
    ├─ ERC-8128 verifyRequest → @slicekit/erc8128 SDK, viem Base mainnet
    │
    ├─ Alchemy API ───────────→ Base Mainnet wallet data (6 parallel calls)
    ├─ Groq LLaMA-3.3 ───────→ AI report generation
    ├─ Pinata IPFS ───────────→ Permanent Filecoin storage
    └─ Status Network ────────→ Gasless per-report proof tx (gasPrice: 0)
```

---

## Track Integrations

### 🔵 Base

All wallet intelligence is sourced entirely from **Base Mainnet** via the Alchemy API:

- `eth_getTransactionCount` — total transaction count
- `eth_getBalance` — ETH balance
- `alchemy_getTokenBalances` — ERC-20 holdings
- `alchemy_getAssetTransfers` — inbound/outbound transfers (ERC-20, ERC-721, ETH)
- `alchemy_getTokenMetadata` — token symbol/name resolution
- Wallet age calculated from first-ever Base transaction timestamp

The report page renders 5 Chart.js visualisations (portfolio pie, tx type bar, timeline, trust score gauge, counterparty bars) all driven by live Base Mainnet data.

**RPC endpoint:** `https://base-mainnet.g.alchemy.com/v2/<key>`

---

### 🟡 Slice — ERC-8128

Every report request is authenticated using the **[ERC-8128](https://github.com/slice-so/ERCs/blob/d9c6f41183008285a0e9f1af1d2aeac72e7a8fdc/ERCS/erc-8128.md) HTTP Message Signature standard** via `@slicekit/erc8128`.

**Full SDK integration** — not just EIP-191:

#### Flow

1. **`GET /.well-known/erc8128`** — Discovery document served via `formatDiscoveryDocument()` from the SDK. Advertises verification endpoint and route policies.

2. **`POST /erc8128/challenge`** — Server uses `formatKeyId()` to build a proper **RFC 9421 signing base** including:
   - `@authority`, `@method`, `@path` components
   - `content-digest: sha-256=:...:` of the canonical request body
   - `@signature-params` with `created`, `expires`, `nonce`, and `keyid` (`erc8128:8453:<address>`)

3. **Browser signs** — MetaMask `personal_sign` signs the RFC 9421 signing base string (exact bytes ERC-8128 requires).

4. **`POST /analyze-signed`** — Server reconstructs a `Request` with proper `Signature-Input` and `Signature` structured-field headers, then calls:
   ```js
   const result = await erc8128Verifier.verifyRequest({ request: syntheticRequest });
   ```
   using `createVerifierClient` from `@slicekit/erc8128` with:
   - `verifyMessage: publicClient.verifyMessage` (viem, Base mainnet)
   - In-memory `NonceStore` for replay protection
   - `maxValiditySec: 300`, `clockSkewSec: 30`

5. **Replay protection** — Each `challengeId` is consumed on first use. Replaying the same signature returns `{ reason: "replay" }`.

#### SDK functions used
| Function | Where |
|---|---|
| `createVerifierClient` | Server startup — creates the persistent verifier |
| `formatKeyId` | Challenge issuance — builds `erc8128:8453:<address>` |
| `formatDiscoveryDocument` | `/.well-known/erc8128` route |
| `verifyRequest` (via client) | `POST /analyze-signed` — the real verification call |

**Package:** `@slicekit/erc8128@0.3.3`

---

### 🟣 Filecoin — Permanent Report Storage

Every generated report is pinned to **IPFS via Pinata** and stored on the Filecoin network.

```js
// agent.js — storeOnFilecoin()
await axios.post('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
  pinataContent: {
    address,
    report: reportText,
    timestamp: new Date().toISOString(),
    generatedBy: 'VIEWER — Autonomous Onchain Intelligence',
    network: 'Base Mainnet'
  },
  pinataMetadata: { name: `viewer-report-${address.slice(0, 8)}-${Date.now()}` }
}, { headers: { Authorization: `Bearer ${PINATA_JWT}` } });
```

The report page shows:
- The IPFS CID
- A live gateway link (`https://gateway.pinata.cloud/ipfs/<CID>`)
- A "View on Filecoin →" button

Every report is permanently accessible on the Filecoin network after generation.

---

### 🔴 Status Network — Per-Report Gasless Proof

Every generated report fires a **gasless (`gasPrice: 0`) transaction** on Status Network Sepolia that encodes `VIEWER:<walletAddress>:<filecoinCID>:<timestamp>` into the calldata of a 0-ETH tx sent to the VIEWER contract. This creates an immutable, verifiable on-chain receipt for every report.

The initial contract deployment (run once):

**Deployment details:**

| Field | Value |
|---|---|
| Network | Status Network Sepolia Testnet |
| RPC | `https://public.sepolia.rpc.status.network` |
| Contract | `0x860255b463c1925363F2F4052376dDC467b1d0a5` |
| Deploy tx | `0x339a397a209324003db1a80d77b58c7b80adb11b90ffb677a918e3a77cc12195` |
| Block | `18102693` |
| Gas Price | 0 (gasless) |
| Explorer | https://sepoliascan.status.network/tx/0x339a397a209324003db1a80d77b58c7b80adb11b90ffb677a918e3a77cc12195 |

**Per-report proof tx** (fires automatically on every report generation in `agent.js`):
```js
await wallet.sendTransaction({
  to: RECEIPT_CONTRACT,   // VIEWER contract on Status Network
  data: ethers.hexlify(ethers.toUtf8Bytes(`VIEWER:${walletAddress}:${filecoinCID}:${Date.now()}`)),
  value: 0n,
  gasPrice: 0,            // gasless — Status Network's key feature
  gasLimit: 100000,
});
```

Each report's proof tx hash is shown live on the report page with a direct explorer link.

---

## Key Files

| File | Purpose |
|---|---|
| `index.js` | Express server — all routes, ERC-8128 challenge/verify, report rendering |
| `agent.js` | Wallet data fetching (Alchemy/Base), Groq AI report generation, Filecoin storage |
| `status-network.js` | Gasless contract deployment on Status Network Sepolia |

---

## Environment Variables

```env
PRIVATE_KEY=           # Wallet private key (agent signer + Status Network)
ALCHEMY_API_KEY=       # Alchemy API key for Base Mainnet
GROQ_API_KEY=          # Groq API key (LLaMA-3.3-70b)
PINATA_JWT=            # Pinata JWT for IPFS/Filecoin storage
STATUS_NETWORK_RPC=    # https://public.sepolia.rpc.status.network
PORT=3000

# x402 payment settings
PAY_TO_ADDRESS=        # Your wallet address to receive USDC payments
X402_NETWORK=          # base-sepolia (testnet) or base (mainnet)
REPORT_PRICE=          # $0.50
```

---

## Hackathon Tracks

| Track | Integration | Status |
|---|---|---|
| **Base** | All wallet data from Base Mainnet via Alchemy · x402 payment settled on Base Sepolia | ✅ |
| **Slice (ERC-8128)** | `createVerifierClient`, `formatKeyId`, `formatDiscoveryDocument`, `verifyRequest` from `@slicekit/erc8128` | ✅ |
| **Filecoin** | Every report pinned to IPFS/Filecoin via Pinata — CID + gateway link on report page | ✅ |
| **Status Network** | Contract deployed gaslessly · Per-report proof tx fires on every report generation | ✅ |

## Payment Flow (x402)

| Step | What happens |
|---|---|
| User hits `/analyze-signed` | Server returns `402 Payment Required` with USDC amount + recipient |
| Browser calls `eth_signTypedData_v4` | EIP-3009 `TransferWithAuthorization` signature — no pre-approval needed |
| Retry with `X-PAYMENT` header | Coinbase facilitator verifies payment on Base Sepolia |
| Payment confirmed | ERC-8128 auth checked, analysis proceeds |

**Testnet:** Base Sepolia USDC — get free test tokens at https://faucet.circle.com  
**Mainnet:** Set `X402_NETWORK=base` in `.env` — no code changes required

---

## Theme Alignment — "Agents that Trust"

VIEWER addresses the **"Agents that trust"** theme from the Synthesis hackathon brief:

> *"Your agent interacts with other agents and services. But trust flows through centralized registries and API key providers."*

VIEWER gives AI agents and their operators a way to **verify wallet reputation onchain** before transacting. The ERC-8128 authentication layer means the report request itself is authenticated without passwords or accounts — just an Ethereum wallet. The report data lives permanently on Filecoin, not inside a platform that can vanish.

---

*Built at The Synthesis · March 2025*
