// ─── LOCAL x402 EVM FACILITATOR SERVER ───────────────────────────────────────
// Runs a tiny HTTP server on FACILITATOR_PORT (default 3001) that implements
// the x402 facilitator REST API (/verify, /settle, /supported).
//
// paymentMiddleware points at http://localhost:3001 instead of x402.org.
// All verification and settlement is done on-chain directly using the
// x402 npm package — no remote calls, no API keys required.
//
// The server wallet (PRIVATE_KEY) submits transferWithAuthorization on Base
// and receives the USDC. Gas on Base Sepolia is negligible.

'use strict';

const http = require('http');
const { ethers } = require('ethers');

const FACILITATOR_PORT = parseInt(process.env.FACILITATOR_PORT || '3001', 10);
let _clients = null;

// ─── VIEM CLIENTS ─────────────────────────────────────────────────────────────
async function getClients() {
  if (_clients) return _clients;

  const { createPublicClient, createWalletClient, http: viemHttp } = await import('viem');
  const { baseSepolia, base } = await import('viem/chains');
  const { privateKeyToAccount } = await import('viem/accounts');

  const network = process.env.X402_NETWORK || 'base-sepolia';
  const chain   = network === 'base' ? base : baseSepolia;

  // Use Alchemy for both mainnet and testnet — more reliable than public endpoints
  const alchemyKey = process.env.ALCHEMY_API_KEY;
  const rpcUrl = network === 'base'
    ? `https://base-mainnet.g.alchemy.com/v2/${alchemyKey}`
    : `https://base-sepolia.g.alchemy.com/v2/${alchemyKey}`;

  const pk  = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY required for local x402 facilitator');
  const rawPk = pk.startsWith('0x') ? pk : '0x' + pk;

  const account      = privateKeyToAccount(rawPk);
  const publicClient = createPublicClient({ chain, transport: viemHttp(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: viemHttp(rpcUrl) });

  _clients = { publicClient, walletClient, account, network };
  return _clients;
}

// ─── FACILITATOR HANDLERS ─────────────────────────────────────────────────────
async function handleVerify(body) {
  const { exact } = require('./node_modules/x402/dist/cjs/schemes/index.js');
  const { publicClient } = await getClients();
  const { paymentPayload, paymentRequirements } = body;
  return await exact.evm.verify(publicClient, paymentPayload, paymentRequirements);
}

async function handleSettle(body) {
  const { exact } = require('./node_modules/x402/dist/cjs/schemes/index.js');
  const { walletClient } = await getClients();
  const { paymentPayload, paymentRequirements } = body;
  const result = await exact.evm.settle(walletClient, paymentPayload, paymentRequirements);
  if (result.success) {
    console.log(`✅ x402 settled — tx: ${result.transaction}`);
  } else {
    console.error(`❌ x402 settle failed: ${result.errorReason}`);
  }
  return result;
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function startFacilitatorServer() {
  // Warm up viem clients
  await getClients();

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/supported') {
      return send(res, 200, { kinds: [] });
    }

    if (req.method !== 'POST') {
      return send(res, 405, { error: 'Method not allowed' });
    }

    let body;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, { error: 'Invalid JSON' }); }

    try {
      if (req.url === '/verify') {
        const result = await handleVerify(body);
        return send(res, result.isValid ? 200 : 402, result);
      }
      if (req.url === '/settle') {
        const result = await handleSettle(body);
        return send(res, result.success ? 200 : 402, result);
      }
      return send(res, 404, { error: 'Unknown endpoint' });
    } catch (err) {
      console.error('Facilitator error:', err.message);
      return send(res, 500, { isValid: false, invalidReason: err.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(FACILITATOR_PORT, () => {
      const { account, network } = _clients;
      console.log(`✅ Local x402 facilitator on :${FACILITATOR_PORT} — ${network} — settler: ${account.address}`);
      resolve(`http://localhost:${FACILITATOR_PORT}`);
    });
    server.on('error', reject);
  });
}

module.exports = { startFacilitatorServer, FACILITATOR_PORT };