require('dotenv').config();
const axios = require('axios');
const Groq = require('groq-sdk');
const { ethers } = require('ethers');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── ERC-8128 AGENT SIGNER ────────────────────────────────────────────────────
// The VIEWER agent signs its outbound HTTP requests using ERC-8128 (RFC 9421).
// This gives every agent action a verifiable Ethereum identity on Base mainnet.
// The @slicekit/erc8128 package is ESM-only, so we use dynamic import().

let _signerClient = null;
let _agentAddress = null;

async function getSignerClient() {
  if (_signerClient) return _signerClient;

  const pk = process.env.PRIVATE_KEY;
  if (!pk) {
    console.warn('No PRIVATE_KEY set — ERC-8128 agent signing disabled');
    return null;
  }

  try {
    const { createSignerClient } = await import('@slicekit/erc8128');
    const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
    _agentAddress = wallet.address;

    const signer = {
      chainId: 8453, // Base mainnet — agent identity lives on Base
      address: wallet.address,
      // SDK passes Uint8Array (RFC 9421 signing base string).
      // We sign keccak256(bytes) with the raw key so verifyRequest can recover it.
      signMessage: async (messageBytes) => {
        const msgHash = ethers.keccak256(messageBytes);
        const sig = wallet.signingKey.sign(msgHash);
        return sig.serialized; // '0x<r><s><v>'
      },
    };

    _signerClient = createSignerClient(signer);
    console.log(`✅ ERC-8128 agent signer active: ${wallet.address} (Base mainnet, chainId 8453)`);
    return _signerClient;
  } catch (err) {
    console.error('ERC-8128 client init failed:', err.message);
    return null;
  }
}

// Sign the report payload before Filecoin storage.
// Returns ERC-8128 headers { signatureInput, signature, contentDigest }
// so verifiers can confirm this report came from the authenticated VIEWER agent.
async function signReportRequest(address, reportHash) {
  const client = await getSignerClient();
  if (!client) return null;

  try {
    const port = process.env.PORT || 3000;
    const body = JSON.stringify({ address, reportHash, timestamp: new Date().toISOString() });
    const req = new Request(`http://localhost:${port}/internal/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const signed = await client.signRequest(req);
    return {
      signatureInput: signed.headers.get('Signature-Input'),
      signature: signed.headers.get('Signature'),
      contentDigest: signed.headers.get('content-digest'),
      agentAddress: _agentAddress,
      chainId: 8453,
    };
  } catch (err) {
    console.error('ERC-8128 sign failed:', err.message);
    return null;
  }
}

async function getAgentAddress() {
  if (_agentAddress) return _agentAddress;
  const pk = process.env.PRIVATE_KEY;
  if (!pk) return null;
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  _agentAddress = wallet.address;
  return wallet.address;
}

// ─── FILECOIN STORAGE via Pinata ──────────────────────────────────────────────
async function storeOnFilecoin(reportText, address, agentAuth) {
  try {
    const token = process.env.PINATA_JWT;
    if (!token) {
      console.log('No PINATA_JWT set, skipping Filecoin storage');
      return null;
    }

    const response = await axios.post(
      'https://api.pinata.cloud/pinning/pinJSONToIPFS',
      {
        pinataContent: {
          address,
          report: reportText,
          timestamp: new Date().toISOString(),
          generatedBy: 'VIEWER — Autonomous Onchain Intelligence',
          network: 'Base Mainnet',
          // ERC-8128 agent signature — verifiable proof this report came from VIEWER agent
          agentAuth: agentAuth || null,
        },
        pinataMetadata: {
          name: `viewer-report-${address.slice(0, 8)}-${Date.now()}`
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const cid = response.data?.IpfsHash;
    console.log(`✅ Stored on Filecoin via Pinata: ${cid}`);
    return cid;
  } catch (err) {
    console.error('Filecoin storage failed:', err.response?.status, JSON.stringify(err.response?.data) || err.message);
    return null;
  }
}

// ─── TOKEN METADATA ───────────────────────────────────────────────────────────
async function getTokenSymbols(tokenList, baseURL) {
  const top5 = tokenList.slice(0, 5);
  const symbols = await Promise.all(
    top5.map(async (token) => {
      try {
        const res = await axios.post(baseURL, {
          jsonrpc: '2.0', id: 1,
          method: 'alchemy_getTokenMetadata',
          params: [token.contractAddress]
        });
        const meta = res.data?.result;
        return {
          symbol: meta?.symbol || 'UNKNOWN',
          name: meta?.name || 'Unknown Token',
          address: token.contractAddress
        };
      } catch {
        return { symbol: 'UNKNOWN', name: 'Unknown Token', address: token.contractAddress };
      }
    })
  );
  return symbols;
}

// ─── WALLET DATA ──────────────────────────────────────────────────────────────
async function getWalletData(address) {
  const baseURL = `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

  const [txCount, balance, tokens, transfersIn, transfersOut, firstTx] = await Promise.all([
    axios.post(baseURL, { jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [address, 'latest'] }),
    axios.post(baseURL, { jsonrpc: '2.0', id: 2, method: 'eth_getBalance', params: [address, 'latest'] }),
    axios.post(baseURL, { jsonrpc: '2.0', id: 3, method: 'alchemy_getTokenBalances', params: [address] }),
    axios.post(baseURL, { jsonrpc: '2.0', id: 4, method: 'alchemy_getAssetTransfers', params: [{ toAddress: address, category: ['external', 'erc20', 'erc721'], maxCount: '0x14', order: 'desc', withMetadata: true }] }),
    axios.post(baseURL, { jsonrpc: '2.0', id: 5, method: 'alchemy_getAssetTransfers', params: [{ fromAddress: address, category: ['external', 'erc20', 'erc721'], maxCount: '0x14', order: 'desc', withMetadata: true }] }),
    axios.post(baseURL, { jsonrpc: '2.0', id: 6, method: 'alchemy_getAssetTransfers', params: [{ fromAddress: address, category: ['external', 'erc20', 'erc721'], maxCount: '0x1', order: 'asc', withMetadata: true }] })
  ]);

  const ethBalance = parseInt(balance.data.result, 16) / 1e18;
  const txCountNum = parseInt(txCount.data.result, 16);
  const tokenList = tokens.data.result?.tokenBalances || [];
  const recentTxs = [
    ...(transfersIn.data.result?.transfers || []),
    ...(transfersOut.data.result?.transfers || [])
  ];
  const firstTxTimestamp = firstTx.data.result?.transfers?.[0]?.metadata?.blockTimestamp || null;
  const tokenSymbols = await getTokenSymbols(tokenList, baseURL);

  return { ethBalance, txCountNum, tokenList, tokenSymbols, recentTxs, address, firstTxTimestamp };
}

// ─── GENERATE REPORT ─────────────────────────────────────────────────────────
async function generateReport(walletData) {
  const { ethBalance, txCountNum, tokenList, tokenSymbols, recentTxs, address, firstTxTimestamp } = walletData;

  let walletAgeStr = 'Unknown';
  if (firstTxTimestamp) {
    const oldest = new Date(firstTxTimestamp);
    const now = new Date();
    const diffDays = Math.floor((now - oldest) / (1000 * 60 * 60 * 24));
    if (diffDays < 30) walletAgeStr = `${diffDays} days`;
    else if (diffDays < 365) walletAgeStr = `${Math.floor(diffDays / 30)} months`;
    else walletAgeStr = `${Math.floor(diffDays / 365)} year${Math.floor(diffDays / 365) > 1 ? 's' : ''}`;
  }

  const tokenSummary = tokenSymbols.map(t => `${t.symbol} (${t.name})`).join(', ');

  const prompt = `You are an expert blockchain intelligence analyst. Analyze this wallet on Base network and write a detailed professional report.

Wallet: ${address}
ETH Balance: ${ethBalance.toFixed(6)} ETH
Total Transactions: ${txCountNum}
Token Holdings: ${tokenList.length} tokens total
Top 5 Tokens: ${tokenSummary || 'None identified'}
Wallet Age: ${walletAgeStr} (first active: ${firstTxTimestamp ? new Date(firstTxTimestamp).toDateString() : 'Unknown'})
Recent Transactions sample: ${JSON.stringify(recentTxs.slice(0, 10), null, 2)}

Write a structured intelligence report. Do NOT include any numbering like "1." or "**1.**" before section titles. Use exactly these section titles:

WALLET SUMMARY
State the wallet age as "${walletAgeStr} old" clearly. Describe activity level, user type (trader, holder, DeFi user, bot), and overall pattern.

PORTFOLIO OVERVIEW
Mention the specific token names: ${tokenSummary}. Assess ETH holdings, token diversity, and estimated portfolio profile.

DEFI ACTIVITY
Protocol interactions detected, trading patterns, yield or lending activity.

RISK FLAGS
Suspicious patterns, counterparty risk. End with: Overall risk level: LOW / MEDIUM / HIGH

NOTABLE COUNTERPARTIES
Most frequent transaction sources or destinations. Notable addresses or contracts.

TRUST SCORE
Score strictly using this rubric:
Baseline: 5
+1 if transactions > 50: ${txCountNum > 50 ? 'yes' : 'no'}
+1 if transactions > 200: ${txCountNum > 200 ? 'yes' : 'no'}
+1 if token holdings > 10: ${tokenList.length > 10 ? 'yes' : 'no'}
+1 if no suspicious patterns: (your assessment)
-2 if 0 transactions: ${txCountNum === 0 ? 'yes' : 'no'}
-1 if ETH balance is 0: ${ethBalance === 0 ? 'yes' : 'no'}
-1 if suspicious patterns detected: (your assessment)
Show calculation then write: Score: X/10

Be sharp, professional, and data-driven.`;

  const completion = await groq.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: 'llama-3.3-70b-versatile',
    max_tokens: 1500,
    temperature: 0.1,
  });

  return completion.choices[0].message.content;
}

// ─── STATUS NETWORK — PER-REPORT PROOF TX ────────────────────────────────────
// After every report, fire a gasless (gasPrice=0) transaction on Status Network
// Sepolia that logs the wallet address + Filecoin CID on-chain.
// This creates an immutable, verifiable receipt for every report generated.

async function logReportOnStatusNetwork(walletAddress, filecoinCID) {
  const rpc = process.env.STATUS_NETWORK_RPC;
  const pk  = process.env.PRIVATE_KEY;
  if (!rpc || !pk) {
    console.log('Status Network logging skipped — RPC or PRIVATE_KEY not set');
    return null;
  }

  try {
    const provider = new ethers.JsonRpcProvider(rpc);
    const wallet   = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk, provider);

    // Encode: "VIEWER:<walletAddress>:<filecoinCID>" as calldata
    // Logging this in the data field of a 0-ETH gasless tx to a known receipt address
    const RECEIPT_CONTRACT = '0x860255b463c1925363F2F4052376dDC467b1d0a5'; // VIEWER contract on Status Sepolia
    const logData = ethers.hexlify(
      ethers.toUtf8Bytes(`VIEWER:${walletAddress}:${filecoinCID || 'no-cid'}:${Date.now()}`)
    );

    const tx = await wallet.sendTransaction({
      to: RECEIPT_CONTRACT,
      data: logData,
      value: 0n,
      gasPrice: 0,       // gasless — Status Network's key feature
      gasLimit: 100000,
    });

    console.log(`✅ Status Network proof tx: ${tx.hash}`);
    console.log(`   Explorer: https://sepoliascan.status.network/tx/${tx.hash}`);

    // Don't block report delivery waiting for confirmation
    tx.wait().then(receipt => {
      console.log(`✅ Status Network tx confirmed — block ${receipt.blockNumber}`);
    }).catch(err => {
      console.error('Status Network confirmation error:', err.message);
    });

    return {
      txHash: tx.hash,
      explorerUrl: `https://sepoliascan.status.network/tx/${tx.hash}`,
      network: 'Status Network Sepolia',
      gasPrice: 0,
    };
  } catch (err) {
    // Non-fatal — never block report delivery for this
    console.error('Status Network logging failed:', err.message);
    return null;
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function analyzeWallet(address) {
  // Warm up the ERC-8128 signer early (lazy-initializes the ESM module)
  await getSignerClient();

  const walletData = await getWalletData(address);
  const report = await generateReport(walletData);

  // Sign the report with ERC-8128 before Filecoin storage
  const reportHash = ethers.keccak256(ethers.toUtf8Bytes(report));
  const agentAuth = await signReportRequest(address, reportHash);
  if (agentAuth) {
    console.log(`✅ ERC-8128 report signed by agent ${agentAuth.agentAddress}`);
  }

  // Store permanently on Filecoin via Pinata
  const filecoinCID = await storeOnFilecoin(report, address, agentAuth);

  // Log an on-chain receipt on Status Network (gasless, non-blocking)
  const statusProof = await logReportOnStatusNetwork(address, filecoinCID);

  const agentAddress = await getAgentAddress();

  return { walletData, report, filecoinCID, agentAuth, agentAddress, statusProof };
}

module.exports = { analyzeWallet, getAgentAddress };