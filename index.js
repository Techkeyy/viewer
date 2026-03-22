require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { analyzeWallet } = require('./agent');

// ─── ERC-8128 SDK SETUP ───────────────────────────────────────────────────────
// @slicekit/erc8128 is ESM-only; we load it once via dynamic import at startup.
// The verifier uses viem's publicClient.verifyMessage on Base mainnet and an
// in-memory NonceStore for replay protection — exactly per the ERC-8128 spec.

let erc8128Verifier = null; // set after async init

async function initERC8128() {
  const { createVerifierClient } = await import('@slicekit/erc8128');
  const { createPublicClient, http } = await import('viem');
  const { base } = await import('viem/chains');

  const publicClient = createPublicClient({ chain: base, transport: http() });

  // In-memory nonce store — prevents signature replay within TTL window
  const nonceMap = new Map();
  const nonceStore = {
    async consume(key, ttlSeconds) {
      const now = Date.now();
      for (const [k, exp] of nonceMap) { if (exp < now) nonceMap.delete(k); }
      if (nonceMap.has(key)) return false;
      nonceMap.set(key, now + ttlSeconds * 1000);
      return true;
    }
  };

  erc8128Verifier = createVerifierClient({
    verifyMessage: publicClient.verifyMessage,
    nonceStore,
    defaults: { maxValiditySec: 300, clockSkewSec: 30, replayable: false }
  });

  console.log('✅ ERC-8128 verifier initialised (Slice SDK + Base mainnet)');
}

initERC8128().catch(e => console.error('ERC-8128 init failed:', e.message));

// ─── x402 PAYMENT MIDDLEWARE ──────────────────────────────────────────────────
// Gates /analyze-signed behind a $0.50 USDC payment on Base Sepolia (testnet).
// Uses a local facilitator server (facilitator.js on FACILITATOR_PORT) that calls
// the x402 npm package directly — no x402.org or CDP API keys needed.
//
// Requirements:
//   ALCHEMY_API_KEY must have Base Sepolia enabled (dashboard.alchemy.com)
//   PRIVATE_KEY wallet must have ETH on Base Sepolia for gas (small amount)
//   Test USDC from https://faucet.circle.com (Base Sepolia network)
//
// To switch to mainnet: set X402_NETWORK=base in .env (no code changes needed)

const { paymentMiddleware } = require('x402-express');
const { startFacilitatorServer, FACILITATOR_PORT } = require('./facilitator');

const PAY_TO_ADDRESS = process.env.PAY_TO_ADDRESS || '0xF6F4bFC77c1d3cbbF39802BaBFb6f0Ba90178214';
const X402_NETWORK   = process.env.X402_NETWORK   || 'base-sepolia';
const REPORT_PRICE   = process.env.REPORT_PRICE   || '$0.50';

// Register payment middleware synchronously using the known local facilitator URL.
// The facilitator server starts async below — requests that arrive before it's
// ready will get a 503 from the facilitator's /verify endpoint, which x402-express
// surfaces as a 402 with an error message. In practice the facilitator is ready
// within 2-3 seconds of server start.
const LOCAL_FACILITATOR_URL = `http://localhost:${FACILITATOR_PORT}`;

app.use(paymentMiddleware(
  PAY_TO_ADDRESS,
  {
    'POST /analyze-signed': {
      price: REPORT_PRICE,
      network: X402_NETWORK,
      config: {
        description: 'VIEWER — AI wallet intelligence report',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
      }
    }
  },
  { url: LOCAL_FACILITATOR_URL }
));

// Start local facilitator server (async — clients warm up in background)
startFacilitatorServer().then(() => {
  console.log(`✅ x402 payment gate: ${REPORT_PRICE} USDC on ${X402_NETWORK} → ${PAY_TO_ADDRESS}`);
}).catch(err => {
  console.error('❌ Local facilitator failed to start:', err.message);
});

// ─── HOME ─────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VIEWER — Onchain Intelligence</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
  :root{--black:#080808;--white:#f0ede6;--acid:#c8ff00;--dim:#1a1a1a;--muted:#3a3a3a;--text-dim:#888;}
  html,body{background:var(--black);color:var(--white);font-family:'Space Mono',monospace;min-height:100vh;overflow-x:hidden;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(200,255,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(200,255,0,0.03) 1px,transparent 1px);background-size:60px 60px;animation:gridMove 20s linear infinite;pointer-events:none;z-index:0;}
  @keyframes gridMove{0%{background-position:0 0}100%{background-position:60px 60px}}
  body::after{content:'';position:fixed;inset:0;background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px);pointer-events:none;z-index:0;}
  nav{position:relative;z-index:10;display:flex;justify-content:space-between;align-items:center;padding:2rem 3rem;border-bottom:1px solid rgba(200,255,0,0.1);}
  .logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1.1rem;letter-spacing:0.3em;color:var(--acid);text-transform:uppercase;}
  .nav-tag{font-size:0.65rem;color:var(--text-dim);letter-spacing:0.2em;text-transform:uppercase;border:1px solid var(--muted);padding:0.3rem 0.8rem;border-radius:2px;}
  .pulse-dot{display:inline-block;width:6px;height:6px;background:var(--acid);border-radius:50%;margin-right:0.5rem;animation:pulse 2s ease-in-out infinite;vertical-align:middle;}
  @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.4;transform:scale(0.7)}}
  .hero{position:relative;z-index:1;padding:6rem 3rem 4rem;max-width:900px;margin:0 auto;}
  .hero-title{font-family:'Syne',sans-serif;font-size:clamp(3rem,8vw,6.5rem);font-weight:800;line-height:0.9;letter-spacing:-0.02em;margin-bottom:2rem;animation:fadeUp 0.6s ease 0.1s both;}
  .hero-title .outline{-webkit-text-stroke:1px var(--white);color:transparent;}
  .hero-title .acid{color:var(--acid);}
  .hero-sub{font-size:0.85rem;color:var(--text-dim);line-height:1.8;max-width:480px;margin-bottom:4rem;animation:fadeUp 0.6s ease 0.2s both;}
  .stats-row{display:flex;gap:3rem;margin-bottom:5rem;padding-bottom:3rem;border-bottom:1px solid var(--muted);animation:fadeUp 0.6s ease 0.3s both;}
  .stat{display:flex;flex-direction:column;gap:0.3rem;}
  .stat-value{font-family:'Syne',sans-serif;font-size:1.8rem;font-weight:700;color:var(--white);}
  .stat-label{font-size:0.65rem;letter-spacing:0.2em;color:var(--text-dim);text-transform:uppercase;}
  .input-area{position:relative;z-index:1;max-width:900px;margin:0 auto;padding:0 3rem 6rem;animation:fadeUp 0.6s ease 0.4s both;}
  .input-label{font-size:0.7rem;letter-spacing:0.25em;color:var(--text-dim);text-transform:uppercase;margin-bottom:1rem;}
  .wallet-input{width:100%;background:var(--dim);border:1px solid var(--muted);color:var(--white);font-family:'Space Mono',monospace;font-size:0.9rem;padding:1.4rem 1.6rem;outline:none;transition:border-color 0.2s,box-shadow 0.2s;border-radius:2px;letter-spacing:0.05em;margin-bottom:1.5rem;}
  .wallet-input::placeholder{color:var(--muted);}
  .wallet-input:focus{border-color:var(--acid);box-shadow:0 0 0 1px var(--acid);}
  .submit-btn{width:100%;background:var(--acid);color:var(--black);border:none;font-family:'Syne',sans-serif;font-weight:700;font-size:0.9rem;letter-spacing:0.15em;text-transform:uppercase;padding:1.3rem 2rem;cursor:pointer;transition:all 0.15s;border-radius:2px;position:relative;}
  .submit-btn:hover{background:#d4ff1a;transform:translateY(-1px);box-shadow:0 8px 30px rgba(200,255,0,0.2);}
  .submit-btn:disabled{opacity:0.5;cursor:not-allowed;transform:none;}
  .submit-btn::after{content:'→';position:absolute;right:2rem;top:50%;transform:translateY(-50%);font-size:1.1rem;}
  .auth-badge{display:flex;align-items:center;gap:0.8rem;margin-top:1rem;padding:1rem 1.5rem;border:1px solid rgba(200,255,0,0.15);border-radius:2px;background:rgba(200,255,0,0.03);}
  .auth-badge-icon{font-size:1rem;color:var(--acid);}
  .auth-badge-text{font-size:0.65rem;color:var(--text-dim);line-height:1.6;}
  .auth-badge-text strong{color:var(--acid);}
  .price-tag{display:flex;align-items:center;justify-content:space-between;margin-top:1rem;padding:1rem 1.5rem;border:1px solid var(--muted);border-radius:2px;}
  .price-tag-left{font-size:0.7rem;color:var(--text-dim);letter-spacing:0.1em;text-transform:uppercase;}
  .price-tag-right{font-family:'Syne',sans-serif;font-size:1rem;font-weight:700;color:var(--acid);}
  .features{margin-top:2rem;display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--muted);border:1px solid var(--muted);border-radius:2px;overflow:hidden;}
  .feature{background:var(--dim);padding:1.5rem;transition:background 0.2s;}
  .feature:hover{background:#111;}
  .feature-icon{font-size:1.2rem;margin-bottom:0.8rem;}
  .feature-title{font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:700;color:var(--white);margin-bottom:0.4rem;}
  .feature-desc{font-size:0.7rem;color:var(--text-dim);line-height:1.6;}
  .ticker{position:fixed;bottom:0;left:0;right:0;background:var(--acid);color:var(--black);font-size:0.65rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;padding:0.5rem 0;overflow:hidden;z-index:100;}
  .ticker-inner{display:flex;gap:4rem;animation:ticker 25s linear infinite;white-space:nowrap;}
  @keyframes ticker{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
  @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
  .corner-tl,.corner-br{position:fixed;width:60px;height:60px;opacity:0.15;z-index:0;}
  .corner-tl{top:20px;left:20px;border-top:1px solid var(--acid);border-left:1px solid var(--acid);}
  .corner-br{bottom:30px;right:20px;border-bottom:1px solid var(--acid);border-right:1px solid var(--acid);}
  #status-msg{font-size:0.7rem;color:var(--acid);margin-top:0.8rem;min-height:1.2rem;text-align:center;letter-spacing:0.1em;}
</style>
</head>
<body>
<div class="corner-tl"></div>
<div class="corner-br"></div>
<nav>
  <div class="logo">VIEWER</div>
  <div style="display:flex;gap:1rem;align-items:center;">
    <span style="font-size:0.65rem;color:var(--text-dim);">BASE MAINNET</span>
    <div class="nav-tag"><span class="pulse-dot"></span>LIVE</div>
  </div>
</nav>
<div class="hero">
  <h1 class="hero-title">KNOW<br><span class="outline">ANY</span><br><span class="acid">WALLET.</span></h1>
  <p class="hero-sub">Paste an address. Sign with your wallet. Get a full AI-generated intelligence report — transactions, holdings, DeFi activity, risk flags, counterparties. Stored permanently on Filecoin.</p>
  <div class="stats-row">
    <div class="stat"><span class="stat-value">6</span><span class="stat-label">Data Layers</span></div>
    <div class="stat"><span class="stat-value">5</span><span class="stat-label">Visual Charts</span></div>
    <div class="stat"><span class="stat-value">$0.50</span><span class="stat-label">Per Report</span></div>
    <div class="stat"><span class="stat-value">0</span><span class="stat-label">Humans in Loop</span></div>
  </div>
</div>
<div class="input-area">
  <p class="input-label">Enter wallet address to analyze</p>
  <input class="wallet-input" id="addressInput" placeholder="0x0000000000000000000000000000000000000000" autocomplete="off" spellcheck="false"/>
  <button class="submit-btn" id="generateBtn" onclick="handleGenerate()">Pay $0.50 USDC & Generate Report</button>
  <div id="status-msg"></div>
  <div id="balance-warning" style="display:none;margin-top:0.8rem;padding:1rem 1.3rem;border-radius:3px;border:1px solid #f87171;background:rgba(248,113,113,0.06);display:none;align-items:flex-start;gap:0.8rem;">
    <span style="font-size:1rem;flex-shrink:0;">⚠</span>
    <div style="font-size:0.7rem;line-height:1.8;color:#f87171;">
      <strong>Insufficient USDC balance</strong><br>
      Your wallet has <span id="usdc-balance-display">0</span> USDC on Base Sepolia. You need at least $0.50 to generate a report.<br>
      <a href="https://faucet.circle.com" target="_blank" style="color:#fb923c;text-decoration:none;font-weight:700;">→ Get free test USDC at faucet.circle.com</a>
      &nbsp;·&nbsp;
      <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" style="color:#fb923c;text-decoration:none;font-weight:700;">→ Get Base Sepolia ETH</a>
    </div>
  </div>

  <div class="auth-badge">
    <span class="auth-badge-icon">◈</span>
    <div class="auth-badge-text">
      <strong>Pay via x402 on Base · Auth via ERC-8128 (Slice)</strong><br>
      Pay $0.50 USDC on Base Sepolia using the x402 protocol — then authenticate with your Ethereum wallet via ERC-8128. No passwords, no accounts. One payment, one report, permanent on Filecoin.
    </div>
  </div>

  <div class="price-tag">
    <span class="price-tag-left">Cost per report · Commerce powered by Slice on Base</span>
    <span class="price-tag-right">0.50 USDC</span>
  </div>

  <div style="margin-top:0.8rem;padding:0.8rem 1.3rem;border:1px solid #2a2a2a;border-radius:3px;display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
    <span style="font-size:0.62rem;color:#555;letter-spacing:0.12em;text-transform:uppercase;">Need testnet USDC?</span>
    <div style="display:flex;gap:1rem;flex-wrap:wrap;">
      <a href="https://faucet.circle.com" target="_blank" style="font-size:0.62rem;color:#888;text-decoration:none;border:1px solid #333;padding:0.3rem 0.8rem;border-radius:2px;transition:all 0.2s;" onmouseover="this.style.color='#c8ff00';this.style.borderColor='#c8ff00'" onmouseout="this.style.color='#888';this.style.borderColor='#333'">USDC Faucet (Circle) →</a>
      <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" style="font-size:0.62rem;color:#888;text-decoration:none;border:1px solid #333;padding:0.3rem 0.8rem;border-radius:2px;transition:all 0.2s;" onmouseover="this.style.color='#c8ff00';this.style.borderColor='#c8ff00'" onmouseout="this.style.color='#888';this.style.borderColor='#333'">Base Sepolia ETH →</a>
      <a href="https://sepolia.basescan.org/address/0x036CbD53842c5426634e7929541eC2318f3dCF7e" target="_blank" style="font-size:0.62rem;color:#888;text-decoration:none;border:1px solid #333;padding:0.3rem 0.8rem;border-radius:2px;transition:all 0.2s;" onmouseover="this.style.color='#c8ff00';this.style.borderColor='#c8ff00'" onmouseout="this.style.color='#888';this.style.borderColor='#333'">USDC Contract →</a>
    </div>
  </div>

  <div class="features">
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">Transaction History</div><div class="feature-desc">Full summary of onchain activity and behavioural patterns</div></div>
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">Portfolio Breakdown</div><div class="feature-desc">Named token holdings with interactive pie chart</div></div>
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">Risk & Flags</div><div class="feature-desc">Mixer usage, rug pull exposure, visual risk gauge</div></div>
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">DeFi Activity</div><div class="feature-desc">Protocol interactions across Uniswap, Aave, and more</div></div>
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">Counterparty Map</div><div class="feature-desc">Who this wallet transacts with most frequently</div></div>
    <div class="feature"><div class="feature-icon">◈</div><div class="feature-title">Trust Score</div><div class="feature-desc">AI-generated 1-10 gauge with full reasoning</div></div>
  </div>
</div>

<div class="ticker">
  <div class="ticker-inner">
    <span>VIEWER · AUTONOMOUS ONCHAIN INTELLIGENCE · POWERED BY BASE · STORED ON FILECOIN · AUTH BY SLICE ERC-8128 · NO MIDDLEMEN · PAY ONCE · OWN YOUR DATA ·&nbsp;</span>
    <span>VIEWER · AUTONOMOUS ONCHAIN INTELLIGENCE · POWERED BY BASE · STORED ON FILECOIN · AUTH BY SLICE ERC-8128 · NO MIDDLEMEN · PAY ONCE · OWN YOUR DATA ·&nbsp;</span>
  </div>
</div>

<script>
// ─── NETWORK CONFIG ───────────────────────────────────────────────────────────
const BASE_SEPOLIA = {
  chainId: '0x14A34',          // 84532 in hex
  chainName: 'Base Sepolia Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://sepolia.base.org'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const USDC_DECIMALS = 6;
const REQUIRED_USDC = 0.50;

// ─── ENSURE CORRECT NETWORK ───────────────────────────────────────────────────
async function ensureBaseSepolia(statusEl) {
  const currentChain = await window.ethereum.request({ method: 'eth_chainId' });
  if (currentChain === BASE_SEPOLIA.chainId) return; // already on Base Sepolia

  statusEl.textContent = 'Switching to Base Sepolia...';
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: BASE_SEPOLIA.chainId }],
    });
  } catch (switchErr) {
    // Error 4902 = chain not added yet — add it, then switch
    if (switchErr.code === 4902) {
      statusEl.textContent = 'Adding Base Sepolia network...';
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [BASE_SEPOLIA],
      });
      // After adding, switch to it
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: BASE_SEPOLIA.chainId }],
      });
    } else {
      throw switchErr;
    }
  }
}

// ─── USDC BALANCE CHECK ───────────────────────────────────────────────────────
async function getUSDCBalance(walletAddress) {
  // balanceOf(address) — ERC-20 call via eth_call
  const data = '0x70a08231' + walletAddress.slice(2).padStart(64, '0');
  try {
    const result = await window.ethereum.request({
      method: 'eth_call',
      params: [{ to: USDC_BASE_SEPOLIA, data }, 'latest'],
    });
    const raw = parseInt(result, 16);
    return raw / Math.pow(10, USDC_DECIMALS);
  } catch {
    return null; // non-fatal — don't block if this fails
  }
}

// ─── MAIN FLOW ────────────────────────────────────────────────────────────────
async function handleGenerate() {
  const address = document.getElementById('addressInput').value.trim();
  const btn = document.getElementById('generateBtn');
  const status = document.getElementById('status-msg');
  const warning = document.getElementById('balance-warning');

  // Hide any previous warning
  warning.style.display = 'none';

  if (!address || !address.startsWith('0x') || address.length !== 42) {
    status.textContent = 'Please enter a valid wallet address (0x...)';
    status.style.color = '#f87171';
    return;
  }

  if (!window.ethereum) {
    status.textContent = 'MetaMask not detected — install MetaMask to continue';
    status.style.color = '#f87171';
    return;
  }

  try {
    btn.disabled = true;
    status.style.color = '#c8ff00';

    // Step 1: Connect wallet
    status.textContent = 'Connecting wallet...';
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    const signerAddress = accounts[0];

    // Step 2: Ensure on Base Sepolia
    await ensureBaseSepolia(status);
    status.style.color = '#c8ff00';
    status.textContent = '✓ On Base Sepolia';

    // Step 3: Check USDC balance
    status.textContent = 'Checking USDC balance...';
    const usdcBal = await getUSDCBalance(signerAddress);
    if (usdcBal !== null && usdcBal < REQUIRED_USDC) {
      document.getElementById('usdc-balance-display').textContent =
        usdcBal.toFixed(4) + ' USDC';
      warning.style.display = 'flex';
      status.textContent = '⚠ Insufficient USDC — see warning below';
      status.style.color = '#f87171';
      btn.disabled = false;
      return;
    }
    if (usdcBal !== null) {
      status.textContent = '✓ Balance: ' + usdcBal.toFixed(2) + ' USDC';
    }

    // Step 4: ERC-8128 challenge
    status.textContent = '[1/3] Fetching authentication challenge...';
    const challengeRes = await fetch('/erc8128/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signerAddress }),
    });
    const challenge = await challengeRes.json();
    if (challenge.error) throw new Error(challenge.error);

    // Step 5: Sign ERC-8128
    status.textContent = '[1/3] Sign to authenticate (MetaMask) →';
    const erc8128Sig = await window.ethereum.request({
      method: 'personal_sign',
      params: [challenge.signingString, signerAddress],
    });
    status.textContent = '✓ Authenticated';

    // Step 6: First POST — x402 middleware returns 402
    status.textContent = '[2/3] Requesting payment details...';
    const payload = JSON.stringify({
      address, signerAddress,
      signature: erc8128Sig,
      challengeId: challenge.challengeId,
      chainId: challenge.chainId,
    });

    let firstRes = await fetch('/analyze-signed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });

    // Step 7: Handle 402
    if (firstRes.status === 402) {
      const paymentRequired = await firstRes.json();
      console.log('402 payment required:', JSON.stringify(paymentRequired, null, 2));

      const req = paymentRequired.accepts?.[0];
      if (!req) throw new Error('No payment requirements in 402 response — check server config');

      const { asset, maxAmountRequired, payTo, maxTimeoutSeconds, network, extra } = req;
      const tokenName    = extra?.name    || 'USD Coin';
      const tokenVersion = extra?.version || '2';
      const chainId = network === 'base-sepolia' ? 84532 : 8453;
      const validAfter  = Math.floor(Date.now() / 1000) - 10;
      const validBefore = Math.floor(Date.now() / 1000) + (maxTimeoutSeconds || 60);
      const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map(b => b.toString(16).padStart(2, '0')).join('');

      const amountStr      = String(BigInt(maxAmountRequired));
      const validAfterStr  = String(validAfter);
      const validBeforeStr = String(validBefore);

      const domain = { name: tokenName, version: tokenVersion, chainId, verifyingContract: asset };
      const types = {
        TransferWithAuthorization: [
          { name: 'from',        type: 'address' },
          { name: 'to',          type: 'address' },
          { name: 'value',       type: 'uint256' },
          { name: 'validAfter',  type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce',       type: 'bytes32' },
        ],
      };
      const message = {
        from: signerAddress, to: payTo,
        value: amountStr, validAfter: validAfterStr, validBefore: validBeforeStr, nonce,
      };

      status.textContent = '[2/3] Sign $0.50 USDC payment (MetaMask) →';
      const paymentSig = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [signerAddress, JSON.stringify({ domain, types, primaryType: 'TransferWithAuthorization', message })],
      });
      status.textContent = '✓ Payment signed';

      const paymentPayload = {
        x402Version: 1, scheme: 'exact', network,
        payload: {
          signature: paymentSig,
          authorization: {
            from: signerAddress, to: payTo,
            value: amountStr, validAfter: validAfterStr, validBefore: validBeforeStr, nonce,
          },
        },
      };

      // Step 8: Fresh ERC-8128 challenge + retry
      status.textContent = '[3/3] Final authentication (MetaMask) →';
      const ch2Res = await fetch('/erc8128/challenge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, signerAddress }),
      });
      const challenge2 = await ch2Res.json();
      const erc8128Sig2 = await window.ethereum.request({
        method: 'personal_sign',
        params: [challenge2.signingString, signerAddress],
      });
      status.textContent = 'Submitting — analysing wallet...';

      firstRes = await fetch('/analyze-signed', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-PAYMENT': btoa(JSON.stringify(paymentPayload)),
        },
        body: JSON.stringify({
          address, signerAddress,
          signature: erc8128Sig2,
          challengeId: challenge2.challengeId,
          chainId: challenge2.chainId,
        }),
      });
    }

    const data = await firstRes.json();

    // Handle errors from the second attempt (with X-PAYMENT)
    if (!firstRes.ok || data.error) {
      const errMsg = data.error || 'Server error: ' + firstRes.status;
      // 'fetch failed' means the x402 facilitator (x402.org) is unreachable from the server
      if (errMsg.includes('fetch failed') || errMsg.includes('EAI') || errMsg.includes('ENOTFOUND')) {
        throw new Error('Payment facilitator unreachable — check your internet connection and retry');
      }
      // 'invalid_exact_evm_payload' errors mean the signature was wrong shape
      if (errMsg.includes('invalid_exact_evm')) {
        throw new Error('Payment signature rejected: ' + errMsg + ' — try refreshing and signing again');
      }
      throw new Error(errMsg);
    }

    window.location.href = '/loading?address=' + encodeURIComponent(address) + '&reqId=' + data.reqId;

  } catch (err) {
    if (err.code === 4001) {
      status.textContent = 'Rejected — please approve all prompts to continue';
      status.style.color = '#f87171';
    } else if (err.code === 4902) {
      status.textContent = 'Please add Base Sepolia network manually and retry';
      status.style.color = '#f87171';
    } else {
      status.textContent = '⚠ ' + (err.message || 'Unknown error — check console');
      status.style.color = '#f87171';
      console.error('VIEWER flow error:', err);
    }
    btn.disabled = false;
  }
}
</script>
</body>
</html>`);
});

// ─── ERC-8128 CHALLENGE ISSUANCE ─────────────────────────────────────────────
// The browser fetches a challenge; we build the RFC 9421 signing base string
// (exactly what createSignerClient would produce) and store it server-side.
// The browser signs it with personal_sign, then POSTs the sig to /analyze-signed.

const pendingChallenges = new Map(); // challengeId → { signingString, signerAddress, targetAddress, createdAt }

app.post('/erc8128/challenge', async (req, res) => {
  try {
    const { address, signerAddress } = req.body;
    if (!address || !signerAddress) return res.status(400).json({ error: 'Missing address or signerAddress' });

    const { formatKeyId } = await import('@slicekit/erc8128');

    const CHAIN_ID = 8453; // Base mainnet — agent identity
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresSec = nowSec + 300;
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
    const keyId = formatKeyId(CHAIN_ID, signerAddress);
    const challengeId = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString('base64url');

    // Use the actual request host so this works on localhost AND deployed environments
    const authority = req.headers.host || `localhost:${process.env.PORT || 3000}`;
    const baseUrl   = `${req.protocol || 'http'}://${authority}`;

    // The canonical request body the browser will POST to /analyze-signed
    const canonicalBody = JSON.stringify({ address, signer: signerAddress.toLowerCase() });

    // SHA-256 content-digest of the body (RFC 9421 §2.4)
    const bodyBytes = Buffer.from(canonicalBody, 'utf8');
    const hashBuf = await crypto.subtle.digest('SHA-256', bodyBytes);
    const digestB64 = Buffer.from(hashBuf).toString('base64');
    const contentDigestHeader = `sha-256=:${digestB64}:`;

    // RFC 9421 components — matches what the SDK's signRequest produces for a POST with body
    const components = ['"@authority"', '"@method"', '"@path"', '"content-digest"'];
    const signatureParamsValue =
      `(${components.join(' ')});created=${nowSec};expires=${expiresSec};nonce="${nonce}";keyid="${keyId}"`;

    // RFC 9421 signing base — the exact bytes MetaMask will sign
    const signingBase = [
      `"@authority": ${authority}`,
      `"@method": POST`,
      `"@path": /analyze-signed`,
      `"content-digest": ${contentDigestHeader}`,
      `"@signature-params": ${signatureParamsValue}`,
    ].join('\n');

    pendingChallenges.set(challengeId, {
      signingString: signingBase,
      signatureParamsValue,
      contentDigestHeader,
      canonicalBody,
      signerAddress: signerAddress.toLowerCase(),
      targetAddress: address,
      authority,
      baseUrl,
      nonce,
      chainId: CHAIN_ID,
      createdAt: Date.now(),
    });

    // Clean up stale challenges (older than 10 min)
    for (const [id, ch] of pendingChallenges) {
      if (Date.now() - ch.createdAt > 10 * 60 * 1000) pendingChallenges.delete(id);
    }

    res.json({ challengeId, signingString: signingBase, chainId: CHAIN_ID });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ERC-8128 DISCOVERY DOCUMENT ─────────────────────────────────────────────
app.get('/.well-known/erc8128', async (req, res) => {
  const { formatDiscoveryDocument } = await import('@slicekit/erc8128');
  const host = req.headers.host || `localhost:${process.env.PORT || 3000}`;
  const base = `${req.protocol || 'http'}://${host}`;
  const doc = formatDiscoveryDocument({
    verificationEndpoint: `${base}/erc8128/verify`,
    maxValiditySec: 300,
    routePolicy: {
      '/analyze-signed': { replayable: false },
      default: { replayable: false },
    },
  });
  res.json(doc);
});

// ─── VERIFY SIGNATURE + QUEUE ANALYSIS ───────────────────────────────────────
app.post('/analyze-signed', async (req, res) => {
  const { address, signerAddress, signature, challengeId, chainId } = req.body;

  if (!address || !signerAddress || !signature || !challengeId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Retrieve the stored challenge
  const challenge = pendingChallenges.get(challengeId);
  if (!challenge) {
    return res.status(401).json({ error: 'Challenge not found or expired — please try again' });
  }
  if (challenge.signerAddress !== signerAddress.toLowerCase()) {
    return res.status(401).json({ error: 'Signer mismatch' });
  }
  if (Date.now() - challenge.createdAt > 5 * 60 * 1000) {
    pendingChallenges.delete(challengeId);
    return res.status(401).json({ error: 'Challenge expired — please try again' });
  }

  // ── Real ERC-8128 SDK verification ────────────────────────────────────────
  // Convert the personal_sign hex signature → base64 for the Signature header
  const sigBytes = ethers.getBytes(signature);
  const sigB64 = Buffer.from(sigBytes).toString('base64');

  // Build a proper RFC 9421 signed Request so createVerifierClient can verify it.
  // The canonical body and content-digest were committed to during the challenge,
  // so the verifier sees exactly the same bytes the signer committed to.
  const reqHeaders = new Headers({
    'Content-Type': 'application/json',
    'Content-Digest': challenge.contentDigestHeader,
    'Signature-Input': `eth=${challenge.signatureParamsValue}`,
    'Signature': `eth=:${sigB64}:`,
  });

  const syntheticRequest = new Request(`${challenge.baseUrl}/analyze-signed`, {
    method: 'POST',
    headers: reqHeaders,
    body: challenge.canonicalBody,
  });

  let verifyResult;
  try {
    verifyResult = await erc8128Verifier.verifyRequest({ request: syntheticRequest });
  } catch (err) {
    return res.status(401).json({ error: `ERC-8128 verification error: ${err.message}` });
  }

  if (!verifyResult.ok) {
    return res.status(401).json({
      error: `ERC-8128 signature invalid: ${verifyResult.reason}`,
      detail: verifyResult
    });
  }

  // Verified ✅ — consume the challenge to prevent replay
  pendingChallenges.delete(challengeId);

  // Queue the analysis
  const reqId = Date.now().toString();
  global.pendingRequests = global.pendingRequests || {};
  global.pendingRequests[reqId] = {
    address,
    signerAddress: verifyResult.address, // use the SDK-recovered address
    chainId: verifyResult.chainId,
    status: 'pending',
    erc8128: true
  };

  // Start analysis in background
  analyzeWallet(address).then(result => {
    global.reports = global.reports || {};
    global.reports[reqId] = result;
    global.pendingRequests[reqId].status = 'done';
  }).catch(err => {
    global.pendingRequests[reqId].status = 'error';
    global.pendingRequests[reqId].error = err.message;
  });

  res.json({ reqId, signerAddress: verifyResult.address, chainId: verifyResult.chainId, verified: true, erc8128: true });
});

// ─── LOADING PAGE ─────────────────────────────────────────────────────────────
app.get('/loading', (req, res) => {
  const { address, reqId } = req.query;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Analyzing — VIEWER</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@700;800&display=swap" rel="stylesheet">
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
  :root{--black:#080808;--white:#f0ede6;--acid:#c8ff00;--dim:#1a1a1a;--muted:#3a3a3a;--text-dim:#888;}
  body{background:var(--black);color:var(--white);font-family:'Space Mono',monospace;min-height:100vh;display:flex;align-items:center;justify-content:center;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(200,255,0,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(200,255,0,0.03) 1px,transparent 1px);background-size:60px 60px;animation:gridMove 20s linear infinite;pointer-events:none;}
  @keyframes gridMove{0%{background-position:0 0}100%{background-position:60px 60px}}
  .wrap{position:relative;z-index:1;text-align:center;padding:3rem;}
  .spinner{width:60px;height:60px;border:1px solid var(--muted);border-top-color:var(--acid);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 2rem;}
  @keyframes spin{to{transform:rotate(360deg)}}
  h2{font-family:'Syne',sans-serif;font-size:1.5rem;font-weight:800;color:var(--acid);margin-bottom:1rem;letter-spacing:0.05em;}
  .addr{font-size:0.75rem;color:var(--text-dim);margin-bottom:2rem;word-break:break-all;max-width:400px;margin-left:auto;margin-right:auto;}
  .auth-ok{font-size:0.65rem;color:#4ade80;letter-spacing:0.15em;margin-bottom:2rem;}
  .steps{list-style:none;text-align:left;max-width:320px;margin:0 auto;}
  .steps li{font-size:0.75rem;color:var(--text-dim);padding:0.6rem 0;border-bottom:1px solid #1a1a1a;display:flex;gap:1rem;align-items:center;transition:color 0.3s;}
  .steps li.done{color:var(--acid);}
  .steps li::before{content:'○';color:var(--muted);flex-shrink:0;transition:color 0.3s;}
  .steps li.done::before{content:'●';color:var(--acid);}
</style>
</head>
<body>
<div class="wrap">
  <div class="spinner"></div>
  <h2>ANALYZING WALLET</h2>
  <p class="addr">${address}</p>
  <p class="auth-ok">✓ ERC-8128 SIGNATURE VERIFIED</p>
  <ul class="steps">
    <li id="s1">Fetching onchain data from Base</li>
    <li id="s2">Determining wallet age & token names</li>
    <li id="s3">Scanning DeFi activity</li>
    <li id="s4">Running risk analysis</li>
    <li id="s5">Generating AI report</li>
    <li id="s6">Storing permanently on Filecoin</li>
  </ul>
</div>
<script>
  const steps=['s1','s2','s3','s4','s5','s6'];
  let i=0;
  const iv=setInterval(()=>{if(i<steps.length){document.getElementById(steps[i]).className='done';i++;}},2500);

  function poll() {
    fetch('/status/${reqId}')
      .then(r=>r.json())
      .then(data=>{
        if(data.status==='done'){
          clearInterval(iv);
          steps.forEach(s=>document.getElementById(s).className='done');
          setTimeout(()=>{ window.location.href='/report?id=${reqId}'; },800);
        } else if(data.status==='error'){
          clearInterval(iv);
          document.querySelector('h2').textContent='ERROR';
          document.querySelector('.addr').textContent=data.error||'Something went wrong';
        } else {
          setTimeout(poll, 2000);
        }
      })
      .catch(()=>setTimeout(poll,3000));
  }
  setTimeout(poll, 3000);
</script>
</body>
</html>`);
});

// ─── STATUS CHECK ─────────────────────────────────────────────────────────────
app.get('/status/:reqId', (req, res) => {
  const { reqId } = req.params;
  const pending = global.pendingRequests?.[reqId];
  if (!pending) return res.json({ status: 'unknown' });
  res.json({ status: pending.status, error: pending.error });
});

// ─── REPORT ───────────────────────────────────────────────────────────────────
app.get('/report', (req, res) => {
  const { id } = req.query;
  const report = global.reports?.[id];
  if (!report) return res.status(404).send('Report not found');

  const { walletData, report: reportText, filecoinCID, statusProof } = report;

  const sectionDefs = [
    { key: 'WALLET SUMMARY',         label: 'Wallet Summary',         icon: '◎' },
    { key: 'PORTFOLIO OVERVIEW',     label: 'Portfolio Overview',     icon: '◈' },
    { key: 'DEFI ACTIVITY',          label: 'DeFi Activity',          icon: '⬡' },
    { key: 'RISK FLAGS',             label: 'Risk Flags',             icon: '⚠' },
    { key: 'NOTABLE COUNTERPARTIES', label: 'Notable Counterparties', icon: '◉' },
    { key: 'TRUST SCORE',            label: 'Trust Score',            icon: '★' },
  ];

  const sections = {};
  sectionDefs.forEach(({ key }, idx) => {
    const regex = new RegExp(`(?:\\*{0,2}\\d+\\.?\\s*)?${key}\\*{0,2}`, 'i');
    const match = reportText.search(regex);
    if (match === -1) return;
    const nextDef = sectionDefs[idx + 1];
    let end = reportText.length;
    if (nextDef) {
      const nextRegex = new RegExp(`(?:\\*{0,2}\\d+\\.?\\s*)?${nextDef.key}\\*{0,2}`, 'i');
      const nextMatch = reportText.search(nextRegex);
      if (nextMatch !== -1) end = nextMatch;
    }
    const raw = reportText.slice(match, end);
    sections[key] = raw.replace(regex, '').replace(/\*\*/g, '').replace(/^[\s\n:]+/, '').trim();
  });

  let walletAge = null;
  let walletAgeSince = '';
  if (walletData.firstTxTimestamp) {
    const oldest = new Date(walletData.firstTxTimestamp);
    const now = new Date();
    const diffDays = Math.floor((now - oldest) / (1000 * 60 * 60 * 24));
    walletAgeSince = oldest.toDateString();
    if (diffDays < 30) walletAge = `${diffDays} days`;
    else if (diffDays < 365) walletAge = `${Math.floor(diffDays / 30)} months`;
    else walletAge = `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? 's' : ''}`;
  }

  const scoreMatch = reportText.match(/Score[:\s]*(\d+)\s*\/\s*10/i);
  const trustScore = scoreMatch ? parseInt(scoreMatch[1]) : 5;
  const gaugeColor = trustScore >= 7 ? '#4ade80' : trustScore >= 4 ? '#c8ff00' : '#f87171';
  const riskLevel = trustScore >= 7 ? 'LOW' : trustScore >= 4 ? 'MEDIUM' : 'HIGH';
  const riskColor = trustScore >= 7 ? '#4ade80' : trustScore >= 4 ? '#facc15' : '#f87171';

  const txTypes = { ETH: 0, ERC20: 0, ERC721: 0 };
  const counterparties = {};
  const timelineData = {};

  walletData.recentTxs.forEach(tx => {
    if (tx.category === 'external') txTypes.ETH++;
    else if (tx.category === 'erc20') txTypes.ERC20++;
    else if (tx.category === 'erc721') txTypes.ERC721++;
    const from = tx.from || 'unknown';
    counterparties[from.slice(0,6)+'...'+from.slice(-4)] = (counterparties[from.slice(0,6)+'...'+from.slice(-4)] || 0) + 1;
    if (tx.metadata?.blockTimestamp) {
      const date = tx.metadata.blockTimestamp.slice(0, 10);
      timelineData[date] = (timelineData[date] || 0) + 1;
    }
  });

  const topCounterparties = Object.entries(counterparties).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const timelineLabels = Object.keys(timelineData).sort();
  const timelineValues = timelineLabels.map(d => timelineData[d]);

  const tokenSymbols = walletData.tokenSymbols || [];
  const pieLabels = tokenSymbols.map(t => t.symbol || 'UNKNOWN');
  const pieValues = tokenSymbols.map(() => 1);
  if (walletData.tokenList.length > 5) {
    pieLabels.push(`+${walletData.tokenList.length - 5} more`);
    pieValues.push(walletData.tokenList.length - 5);
  }

  const filecoinLink = filecoinCID ? `https://gateway.pinata.cloud/ipfs/${filecoinCID}` : null;
  const gaugeCircumference = 251.2;
  const gaugeDashoffset = gaugeCircumference - (gaugeCircumference * trustScore / 10);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Report — VIEWER</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@400;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
  *,*::before,*::after{margin:0;padding:0;box-sizing:border-box;}
  :root{--black:#080808;--white:#f0ede6;--acid:#c8ff00;--card:#161616;--muted:#2a2a2a;--border:#222;--text-dim:#666;--text-mid:#999;}
  html,body{background:var(--black);color:var(--white);font-family:'Space Mono',monospace;padding-bottom:6rem;}
  body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(200,255,0,0.02) 1px,transparent 1px),linear-gradient(90deg,rgba(200,255,0,0.02) 1px,transparent 1px);background-size:80px 80px;pointer-events:none;z-index:0;}
  nav{position:relative;z-index:10;display:flex;justify-content:space-between;align-items:center;padding:1.5rem 2.5rem;border-bottom:1px solid rgba(200,255,0,0.08);}
  .logo{font-family:'Syne',sans-serif;font-weight:800;font-size:1rem;letter-spacing:0.3em;color:var(--acid);text-transform:uppercase;text-decoration:none;}
  .page{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:2.5rem;}
  .report-header{margin-bottom:2rem;padding-bottom:1.8rem;border-bottom:1px solid var(--border);}
  .report-tag{font-size:0.58rem;color:var(--acid);letter-spacing:0.3em;text-transform:uppercase;margin-bottom:0.5rem;}
  .report-address{font-size:0.75rem;color:var(--text-mid);word-break:break-all;margin-bottom:1rem;}
  .badges{display:flex;gap:0.6rem;flex-wrap:wrap;}
  .badge{font-size:0.58rem;letter-spacing:0.12em;text-transform:uppercase;padding:0.3rem 0.8rem;border-radius:2px;}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--border);border-radius:5px;overflow:hidden;margin-bottom:1.8rem;}
  .metric{background:var(--card);padding:1.3rem 1.5rem;position:relative;overflow:hidden;}
  .metric::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;transform:scaleX(0);transform-origin:left;animation:mBar 1s ease forwards;}
  .metric:nth-child(1)::after{background:#c8ff00;}
  .metric:nth-child(2)::after{background:#60a5fa;animation-delay:0.1s;}
  .metric:nth-child(3)::after{background:#a78bfa;animation-delay:0.2s;}
  .metric:nth-child(4)::after{background:${gaugeColor};animation-delay:0.3s;}
  @keyframes mBar{to{transform:scaleX(1)}}
  .metric-label{font-size:0.56rem;color:var(--text-dim);letter-spacing:0.2em;text-transform:uppercase;margin-bottom:0.5rem;}
  .metric-value{font-family:'Syne',sans-serif;font-size:1.7rem;font-weight:800;}
  .metric-sub{font-size:0.56rem;color:var(--text-dim);margin-top:0.25rem;}
  .charts-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.2rem;margin-bottom:1.8rem;}
  .chart-card{background:var(--card);border:1px solid var(--border);border-radius:5px;padding:1.3rem;}
  .chart-card.full{grid-column:1/-1;}
  .chart-title{font-family:'Syne',sans-serif;font-size:0.68rem;font-weight:700;color:var(--white);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:0.25rem;}
  .chart-sub{font-size:0.56rem;color:var(--text-dim);margin-bottom:1rem;}
  .chart-wrap{position:relative;height:200px;}
  .chart-wrap.tall{height:220px;}
  .gauge-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;gap:0.6rem;}
  .gauge-svg{width:160px;overflow:visible;}
  .gauge-track{fill:none;stroke:#2a2a2a;stroke-width:12;stroke-linecap:round;}
  .gauge-fill{fill:none;stroke-width:12;stroke-linecap:round;stroke-dasharray:${gaugeCircumference};stroke-dashoffset:${gaugeCircumference};animation:gAnim 1.5s ease 0.4s forwards;}
  @keyframes gAnim{to{stroke-dashoffset:${gaugeDashoffset}}}
  .gauge-num{font-family:'Syne',sans-serif;font-size:2.8rem;font-weight:800;text-align:center;line-height:1;}
  .gauge-sub{font-size:0.56rem;color:var(--text-dim);letter-spacing:0.2em;text-align:center;}
  .gauge-risk{font-size:0.6rem;letter-spacing:0.2em;text-transform:uppercase;font-family:'Syne',sans-serif;font-weight:700;text-align:center;margin-top:0.2rem;}
  .counter-list{display:flex;flex-direction:column;gap:0.9rem;justify-content:center;height:200px;}
  .counter-item{display:grid;grid-template-columns:110px 1fr 22px;gap:0.7rem;align-items:center;}
  .counter-addr{font-size:0.58rem;color:var(--text-mid);}
  .counter-track{height:4px;background:var(--muted);border-radius:2px;overflow:hidden;}
  .counter-bar{height:100%;border-radius:2px;width:0;transition:width 1.3s cubic-bezier(0.4,0,0.2,1);}
  .counter-n{font-size:0.6rem;font-family:'Syne',sans-serif;font-weight:700;text-align:right;}
  .filecoin-card{background:var(--card);border:1px solid rgba(200,255,0,0.15);border-radius:5px;padding:1.3rem 1.5rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem;margin-bottom:1.8rem;}
  .filecoin-left{display:flex;flex-direction:column;gap:0.35rem;min-width:0;}
  .filecoin-label{font-size:0.56rem;color:var(--text-dim);letter-spacing:0.2em;text-transform:uppercase;}
  .filecoin-cid{font-size:0.67rem;color:var(--acid);word-break:break-all;}
  .filecoin-verified{font-size:0.55rem;color:#4ade80;letter-spacing:0.15em;margin-top:0.1rem;}
  .filecoin-btn{background:var(--acid);color:#080808;border:none;font-family:'Syne',sans-serif;font-weight:700;font-size:0.62rem;letter-spacing:0.12em;text-transform:uppercase;padding:0.65rem 1.3rem;border-radius:2px;cursor:pointer;text-decoration:none;white-space:nowrap;flex-shrink:0;transition:background 0.15s;}
  .filecoin-btn:hover{background:#d4ff1a;}
  .slice-card{background:var(--card);border:1px solid rgba(200,255,0,0.1);border-radius:5px;padding:1.3rem 1.5rem;display:flex;align-items:center;gap:1rem;margin-bottom:1.8rem;}
  .slice-icon{font-size:1.2rem;color:var(--acid);flex-shrink:0;}
  .slice-info{display:flex;flex-direction:column;gap:0.2rem;}
  .slice-label{font-size:0.56rem;color:var(--text-dim);letter-spacing:0.2em;text-transform:uppercase;}
  .slice-value{font-size:0.7rem;color:var(--white);}
  .sections-label{font-size:0.58rem;color:var(--text-dim);letter-spacing:0.25em;text-transform:uppercase;margin-bottom:0.8rem;font-family:'Syne',sans-serif;font-weight:700;}
  .sections{display:flex;flex-direction:column;gap:0.6rem;margin-bottom:2rem;}
  .section-card{background:var(--card);border:1px solid var(--border);border-radius:5px;overflow:hidden;}
  .section-card:hover{border-color:#333;}
  .section-hdr{display:grid;grid-template-columns:1.6rem 1fr auto;align-items:center;gap:0.8rem;padding:1rem 1.3rem;cursor:pointer;user-select:none;}
  .section-hdr:hover{background:rgba(255,255,255,0.015);}
  .section-icon{font-size:0.82rem;color:var(--acid);}
  .section-title{font-family:'Syne',sans-serif;font-size:0.78rem;font-weight:700;color:var(--white);}
  .section-arr{font-size:0.58rem;color:var(--text-dim);transition:transform 0.25s;}
  .section-arr.open{transform:rotate(180deg);}
  .section-body{padding:0 1.3rem;max-height:0;overflow:hidden;transition:max-height 0.4s ease,padding 0.3s ease;}
  .section-body.open{max-height:800px;padding:0 1.3rem 1.3rem;}
  .section-text{font-size:0.76rem;line-height:2.1;color:#b0b0b0;border-top:1px solid var(--border);padding-top:1rem;}
  .section-text p{margin-bottom:0.5rem;}
  .section-text p:last-child{margin:0;}
  .back-btn{display:inline-block;font-size:0.68rem;color:var(--text-dim);text-decoration:none;border:1px solid var(--border);padding:0.6rem 1.3rem;border-radius:2px;transition:all 0.2s;}
  .back-btn:hover{color:var(--acid);border-color:var(--acid);}
  @keyframes fadeUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  .page{animation:fadeUp 0.45s ease both;}
</style>
</head>
<body>
<nav>
  <a href="/" class="logo">VIEWER</a>
  <span style="font-size:0.58rem;color:var(--text-dim);letter-spacing:0.15em;">INTELLIGENCE REPORT · BASE MAINNET</span>
</nav>
<div class="page">

  <div class="report-header">
    <div class="report-tag">Intelligence Report · ${new Date().toUTCString()}</div>
    <div class="report-address">${walletData.address}</div>
    <div class="badges">
      ${walletAge ? `<span class="badge" style="background:rgba(200,255,0,0.06);color:var(--acid);border:1px solid rgba(200,255,0,0.2);">◷ ${walletAge} old · since ${walletAgeSince}</span>` : ''}
      <span class="badge" style="color:${riskColor};border:1px solid ${riskColor}33;background:${riskColor}0d;">⚠ ${riskLevel} RISK</span>
      <span class="badge" style="color:#60a5fa;border:1px solid #60a5fa33;background:#60a5fa0d;">◈ ${walletData.tokenList.length} tokens</span>
      <span class="badge" style="color:#a78bfa;border:1px solid #a78bfa33;background:#a78bfa0d;">⬡ ${walletData.txCountNum} txns</span>
      <span class="badge" style="color:#4ade80;border:1px solid #4ade8033;background:#4ade800d;">✓ ERC-8128 VERIFIED</span>
    </div>
  </div>

  <div class="metrics">
    <div class="metric">
      <div class="metric-label">ETH Balance</div>
      <div class="metric-value" style="color:#c8ff00;">${walletData.ethBalance.toFixed(4)}</div>
      <div class="metric-sub">on Base Mainnet</div>
    </div>
    <div class="metric">
      <div class="metric-label">Total Transactions</div>
      <div class="metric-value" style="color:#60a5fa;">${walletData.txCountNum}</div>
      <div class="metric-sub">all time onchain</div>
    </div>
    <div class="metric">
      <div class="metric-label">Token Holdings</div>
      <div class="metric-value" style="color:#a78bfa;">${walletData.tokenList.length}</div>
      <div class="metric-sub">unique assets</div>
    </div>
    <div class="metric">
      <div class="metric-label">Trust Score</div>
      <div class="metric-value" style="color:${gaugeColor};">${trustScore}/10</div>
      <div class="metric-sub" style="color:${riskColor};">${riskLevel} risk</div>
    </div>
  </div>

  <div class="charts-grid">
    <div class="chart-card">
      <div class="chart-title">Portfolio Distribution</div>
      <div class="chart-sub">Top tokens by name</div>
      <div class="chart-wrap"><canvas id="pieChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Transaction Breakdown</div>
      <div class="chart-sub">By asset type</div>
      <div class="chart-wrap"><canvas id="typeChart"></canvas></div>
    </div>
    <div class="chart-card full">
      <div class="chart-title">Transaction Activity — Volume Over Time</div>
      <div class="chart-sub">Daily activity from recent sample</div>
      <div class="chart-wrap tall"><canvas id="timelineChart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Trust Score Gauge</div>
      <div class="chart-sub">Scored from onchain data</div>
      <div class="gauge-wrap">
        <svg class="gauge-svg" viewBox="0 0 160 90">
          <path class="gauge-track" d="M 10 80 A 70 70 0 0 1 150 80"/>
          <path class="gauge-fill" d="M 10 80 A 70 70 0 0 1 150 80" stroke="${gaugeColor}"/>
        </svg>
        <div class="gauge-num" style="color:${gaugeColor};">${trustScore}</div>
        <div class="gauge-sub">OUT OF 10</div>
        <div class="gauge-risk" style="color:${riskColor};">${riskLevel} RISK</div>
      </div>
    </div>
    <div class="chart-card">
      <div class="chart-title">Top Counterparties</div>
      <div class="chart-sub">Most frequent senders in sample</div>
      <div class="counter-list" id="counterList"></div>
    </div>
  </div>

  <div class="filecoin-card">
    <div class="filecoin-left">
      <span class="filecoin-label">Permanently stored · Filecoin via Pinata</span>
      <span class="filecoin-cid">${filecoinCID || 'Filecoin storage not configured'}</span>
      ${filecoinCID ? '<span class="filecoin-verified">✓ VERIFIED ON FILECOIN NETWORK</span>' : ''}
    </div>
    ${filecoinLink
      ? `<a href="${filecoinLink}" target="_blank" class="filecoin-btn">View on Filecoin →</a>`
      : `<span style="font-size:0.6rem;color:var(--text-dim);">NOT CONFIGURED</span>`}
  </div>

  <div class="slice-card">
    <span class="slice-icon" style="color:#f97316;">◈</span>
    <div class="slice-info">
      <span class="slice-label">Proof of Report · Status Network Sepolia · Gasless</span>
      <span class="slice-value">
        ${statusProof
          ? `On-chain receipt logged gaslessly at block — <a href="${statusProof.explorerUrl}" target="_blank" style="color:var(--acid);text-decoration:none;">${statusProof.txHash.slice(0,18)}... →</a>`
          : 'Status Network logging not configured'}
      </span>
    </div>
  </div>

  <div class="slice-card">
    <span class="slice-icon">◈</span>
    <div class="slice-info">
      <span class="slice-label">Paid via x402 · USDC on Base Sepolia · Authentication via Slice ERC-8128</span>
      <span class="slice-value">$0.50 USDC payment settled on Base · Report request authenticated with ERC-8128 HTTP Message Signatures — no passwords, no accounts.</span>
    </div>
  </div>

  <div class="sections-label">Analysis Breakdown</div>
  <div class="sections">
    ${sectionDefs.map(({ key, label, icon }, i) => `
    <div class="section-card">
      <div class="section-hdr" onclick="toggle(${i})">
        <span class="section-icon">${icon}</span>
        <span class="section-title">${label}</span>
        <span class="section-arr ${i === 0 ? 'open' : ''}" id="arr${i}">▼</span>
      </div>
      <div class="section-body ${i === 0 ? 'open' : ''}" id="sec${i}">
        <div class="section-text">${(sections[key]||'No data.').split('\n').filter(l=>l.trim()).map(l=>`<p>${l.trim()}</p>`).join('')}</div>
      </div>
    </div>`).join('')}
  </div>

  <a href="/" class="back-btn">← Analyze another wallet</a>
</div>

<script>
Chart.defaults.color='#666';
Chart.defaults.borderColor='#222';
Chart.defaults.font.family="'Space Mono',monospace";
Chart.defaults.font.size=10;
const C=['#c8ff00','#60a5fa','#a78bfa','#fb923c','#4ade80','#f87171'];

new Chart(document.getElementById('pieChart'),{
  type:'doughnut',
  data:{labels:${JSON.stringify(pieLabels)},datasets:[{data:${JSON.stringify(pieValues)},backgroundColor:C,borderWidth:2,borderColor:'#161616',hoverOffset:8}]},
  options:{responsive:true,maintainAspectRatio:false,animation:{animateRotate:true,duration:1200,easing:'easeOutQuart'},plugins:{legend:{position:'right',labels:{color:'#888',font:{size:10},boxWidth:10,padding:12}}},cutout:'65%'}
});

new Chart(document.getElementById('typeChart'),{
  type:'bar',
  data:{labels:['ETH','ERC-20','ERC-721'],datasets:[{data:[${txTypes.ETH},${txTypes.ERC20},${txTypes.ERC721}],backgroundColor:['rgba(200,255,0,0.4)','rgba(96,165,250,0.4)','rgba(167,139,250,0.4)'],borderColor:['#c8ff00','#60a5fa','#a78bfa'],borderWidth:1,borderRadius:4,borderSkipped:false}]},
  options:{responsive:true,maintainAspectRatio:false,animation:{duration:900,easing:'easeOutBounce'},plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#666'}},y:{grid:{color:'#1a1a1a'},ticks:{color:'#666',stepSize:1},beginAtZero:true}}}
});

const tlL=${JSON.stringify(timelineLabels)};
const tlV=${JSON.stringify(timelineValues)};
if(tlL.length>0){
  new Chart(document.getElementById('timelineChart'),{
    type:'line',
    data:{labels:tlL,datasets:[{label:'Txns',data:tlV,borderColor:'#c8ff00',backgroundColor:'rgba(200,255,0,0.08)',borderWidth:2,pointBackgroundColor:'#c8ff00',pointRadius:4,pointHoverRadius:6,fill:true,tension:0.4}]},
    options:{responsive:true,maintainAspectRatio:false,animation:{duration:1200,easing:'easeOutQuart'},plugins:{legend:{display:false}},scales:{x:{grid:{display:false},ticks:{color:'#666',maxTicksLimit:8}},y:{grid:{color:'#1a1a1a'},ticks:{color:'#666',stepSize:1},beginAtZero:true}}}
  });
}else{
  document.getElementById('timelineChart').parentElement.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:220px;color:#555;font-size:0.7rem;">No timestamped data — try a more active wallet</div>';
}

const cData=${JSON.stringify(topCounterparties)};
const cColors=['#c8ff00','#60a5fa','#a78bfa','#fb923c','#4ade80'];
const cMax=cData.length?Math.max(...cData.map(c=>c[1])):1;
const cList=document.getElementById('counterList');
if(!cData.length){cList.innerHTML='<div style="color:#555;font-size:0.7rem;text-align:center;">No data in sample</div>';}
else{cData.forEach(([addr,n],i)=>{const pct=(n/cMax*100).toFixed(0);const col=cColors[i%cColors.length];const d=document.createElement('div');d.className='counter-item';d.innerHTML=\`<span class="counter-addr">\${addr}</span><div class="counter-track"><div class="counter-bar" id="cb\${i}" style="background:\${col}"></div></div><span class="counter-n" style="color:\${col}">\${n}</span>\`;cList.appendChild(d);setTimeout(()=>{document.getElementById('cb'+i).style.width=pct+'%';},200+i*100);});}

function toggle(i){const b=document.getElementById('sec'+i);const a=document.getElementById('arr'+i);const o=b.classList.contains('open');b.classList.toggle('open',!o);a.classList.toggle('open',!o);}
<\/script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ VIEWER running at http://localhost:${PORT}`);
});