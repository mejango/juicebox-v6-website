// src/safe.js
// Safe (multisig) support for owner/operator-gated actions. When a project owner is a Safe, we can't
// route through Relayr (a Safe has no private key to sign an ERC-2771 forward request). Instead we
// PROPOSE the call to the Safe Transaction Service on each chain — it lands in the Safe's queue, and the
// Safe's signers confirm + execute (from the Safe app, or from our Owner/Operator/Admin tabs).
//
// Caveats (flagged for live testing): the per-network Safe Transaction Service endpoints below may
// require an API key and/or restrict browser CORS depending on Safe's current API policy. The base URL
// and an optional API key are configurable (localStorage) so this can be pointed at a working endpoint
// without a rebuild; every call degrades gracefully (throws a readable error) so the UI can fall back to
// the "Open in Safe app" deep link.

import { hashTypedData, getAddress as checksumAddress, encodeFunctionData } from 'viem';
import { getWalletClient, getAccount, switchChain, createPublicClientForChain, ZERO_ADDRESS as ZERO, getViewAs, VIEW_AS_TX_ERROR } from './component-base.js';
import { CHAINS, chainList, isTestnetChain } from './chain.js';

// The Safe Transaction Service rejects non-checksummed addresses (HTTP 422). Checksum everything we send.
function cs(a) { try { return checksumAddress(a); } catch (_) { return a; } }

// Safe Transaction Service base per chain (legacy per-network hosts). Overridable via localStorage
// `jb-safe-tx-base` (JSON map chainId→base) for environments where these change.
var SAFE_TX_BASE = {
  1: 'https://safe-transaction-mainnet.safe.global',
  10: 'https://safe-transaction-optimism.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  42161: 'https://safe-transaction-arbitrum.safe.global',
  11155111: 'https://safe-transaction-sepolia.safe.global',
};
// Safe app chain shortNames for deep links (https://app.safe.global) AND the gateway path.
// Base Sepolia's hosted Transaction Service IS live (probed 200 on
// api.safe.global/tx-service/basesep/api/v1/about/); omitting it dropped those Safes to the
// on-chain approveHash path with no queue or tx links. OP Sepolia (`opsepolia`) and Arbitrum
// Sepolia (`arb1-sep`) genuinely 404 and are deliberately absent.
var SAFE_PREFIX = { 1: 'eth', 10: 'oeth', 8453: 'base', 42161: 'arb1', 11155111: 'sep', 84532: 'basesep' };

// PRIMARY = Safe's unified gateway. The per-network `safe-transaction-<net>.safe.global` hosts now
// 308-redirect to this gateway, and cross-origin redirects break browser CORS — so hit the gateway
// directly (returns 200 for all chains, no API key). Legacy hosts kept as a fallback.
function txBase(chainId) {
  try {
    var o = JSON.parse(localStorage.getItem('jb-safe-tx-base') || 'null');
    if (o && o[chainId]) return String(o[chainId]).replace(/\/$/, '');
  } catch (_) {}
  var p = SAFE_PREFIX[chainId];
  return p ? ('https://api.safe.global/tx-service/' + p) : (SAFE_TX_BASE[chainId] || null);
}
function legacyBase(chainId) { return SAFE_TX_BASE[chainId] || null; }
function apiKey() { try { return localStorage.getItem('jb-safe-api-key') || ''; } catch (_) { return ''; } }
function headers(json) {
  var h = {};
  if (json) h['Content-Type'] = 'application/json';
  var k = apiKey();
  if (k) h.Authorization = 'Bearer ' + k;
  return h;
}

// Serialize ALL Safe Transaction Service requests through one FIFO queue (concurrency 1). The gateway
// rate-limits bursts with 429, and a multi-chain Back-office load — each chain does a nonce read + a
// pending-list read, with retries — used to fire ~8-16 requests at once and trip it. Trickling them keeps the
// app well under the limit; total latency for a 4-chain load is ~1s, which is fine for an on-demand tab.
// Cap CONCURRENT requests (not strictly serial). Concurrency 1 made a multi-chain Back-office load crawl —
// 8+ requests ran one-at-a-time. A small cap loads several chains at once while staying well under the burst
// threshold that triggers the gateway's 429.
var SAFE_MAX_CONCURRENT = 3;
var _safeActive = 0;
var _safeWaiters = [];
function safeFetch(url, opts) {
  return new Promise(function (resolve, reject) {
    function release() { _safeActive--; var next = _safeWaiters.shift(); if (next) next(); }
    function run() { _safeActive++; fetch(url, opts).then(function (r) { release(); resolve(r); }, function (e) { release(); reject(e); }); }
    if (_safeActive < SAFE_MAX_CONCURRENT) run(); else _safeWaiters.push(run);
  });
}
// Collapse concurrent identical nonce reads (listPendingSafeTxs reads the nonce too) — in-flight only, no TTL,
// so the propose path never sees a stale nonce.
var _nonceInflight = {};

export function safeQueueLink(chainId, safe) {
  var p = SAFE_PREFIX[chainId];
  return p ? ('https://app.safe.global/transactions/queue?safe=' + p + ':' + safe) : null;
}
// Safe app home (any chain it's on) — where the user can "Add another network" to deploy the same-address
// Safe to a chain it isn't on yet.
export function safeHomeLink(chainId, safe) {
  var p = SAFE_PREFIX[chainId] || 'eth';
  return 'https://app.safe.global/home?safe=' + p + ':' + safe;
}
export function safeTxLink(chainId, safe, safeTxHash) {
  var p = SAFE_PREFIX[chainId];
  return p ? ('https://app.safe.global/transactions/tx?safe=' + p + ':' + safe + '&id=multisig_' + safe + '_' + safeTxHash) : null;
}

// SafeTx EIP-712 (Safe ≥1.3.0: domain is just {chainId, verifyingContract}).
var SAFE_TX_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};
function safeTxMessage(fields) {
  return {
    to: fields.to, value: BigInt(fields.value || 0), data: fields.data || '0x',
    operation: Number(fields.operation || 0), safeTxGas: BigInt(fields.safeTxGas || 0),
    baseGas: BigInt(fields.baseGas || 0), gasPrice: BigInt(fields.gasPrice || 0),
    gasToken: fields.gasToken || ZERO, refundReceiver: fields.refundReceiver || ZERO,
    nonce: BigInt(fields.nonce),
  };
}
function safeTxHashOf(chainId, safe, fields) {
  return hashTypedData({
    domain: { chainId: Number(chainId), verifyingContract: safe },
    types: SAFE_TX_TYPES, primaryType: 'SafeTx', message: safeTxMessage(fields),
  });
}
// Sign the SafeTx with the connected wallet. MetaMask/Ledger require the active chain to equal the EIP-712
// domain chainId, so switch first.
async function signSafeTx(chainId, safe, fields, signer) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) {
    if (e && e.code === 4001) throw e;
    throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to sign.');
  }
  if (!getAccount() || getAccount().toLowerCase() !== signer.toLowerCase()) throw new Error('Connected account changed. Review the Safe transaction again.');
  var signature = await wallet.signTypedData({
    account: signer, domain: { chainId: Number(chainId), verifyingContract: safe },
    types: SAFE_TX_TYPES, primaryType: 'SafeTx', message: safeTxMessage(fields),
  });
  if (!getAccount() || getAccount().toLowerCase() !== signer.toLowerCase()) throw new Error('Connected account changed. Review the Safe transaction again.');
  return signature;
}

// The Safe's current queue nonce (next nonce to use). Reads the service; falls back to onchain `nonce()`.
export function getSafeNextNonce(chainId, safe) {
  var key = chainId + ':' + String(safe).toLowerCase();
  if (_nonceInflight[key]) return _nonceInflight[key];
  var p = (async function () {
    var base = txBase(chainId);
    if (base) {
      try {
        var r = await safeFetch(base + '/api/v1/safes/' + cs(safe) + '/', { headers: headers(false) });
        if (r.ok) { var d = await r.json(); if (d && d.nonce != null) return Number(d.nonce); }
      } catch (_) {}
    }
    // Onchain fallback.
    try {
      var pub = createPublicClientForChain(chainId);
      var n = await pub.readContract({ address: safe, abi: [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'nonce', args: [] });
      return Number(n);
    } catch (_) { return null; }
  })();
  _nonceInflight[key] = p;
  p.then(function () { delete _nonceInflight[key]; }, function () { delete _nonceInflight[key]; });
  return p;
}

// Propose a transaction to the Safe's queue on `chainId`. Returns { safeTxHash, nonce }.
export async function proposeSafeTx(opts) {
  // opts: { chainId, safe, to, data, value, signer }
  var base = txBase(opts.chainId);
  if (!base) throw new Error('No Safe Transaction Service configured for ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId));
  // Caller may pick the nonce (e.g. to replace a queued tx); otherwise use the recommended next nonce.
  var nonce = (opts.nonce != null) ? Number(opts.nonce) : await getSafeNextNonce(opts.chainId, opts.safe);
  if (nonce == null) throw new Error('Could not read the Safe nonce on ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId) + '.');
  var fields = { to: opts.to, value: opts.value || 0, data: opts.data || '0x', operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: nonce };
  var safeTxHash = safeTxHashOf(opts.chainId, opts.safe, fields);
  var signature = await signSafeTx(opts.chainId, opts.safe, fields, opts.signer);
  var body = {
    to: cs(fields.to), value: String(fields.value), data: fields.data, operation: 0,
    safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO,
    nonce: String(nonce), contractTransactionHash: safeTxHash, sender: cs(opts.signer),
    signature: signature, origin: 'Juicebox V6 explorer',
  };
  var res = await safeFetch(base + '/api/v1/safes/' + cs(opts.safe) + '/multisig-transactions/', {
    method: 'POST', headers: headers(true), body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201) {
    var detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error('Safe service ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  return {
    safeTxHash: safeTxHash,
    nonce: nonce,
    signature: signature,
    tx: {
      to: fields.to,
      value: String(fields.value),
      data: fields.data,
      operation: fields.operation,
      safeTxGas: String(fields.safeTxGas),
      baseGas: String(fields.baseGas),
      gasPrice: String(fields.gasPrice),
      gasToken: fields.gasToken,
      refundReceiver: fields.refundReceiver,
      nonce: nonce,
      safeTxHash: safeTxHash,
      contractTransactionHash: safeTxHash,
      confirmations: [{ owner: cs(opts.signer), signature: signature }],
    },
  };
}

// List the Safe's pending (not-yet-executed) queued transactions on `chainId`.
export async function listPendingSafeTxs(chainId, safe) {
  var base = txBase(chainId);
  if (!base) return [];
  // Only nonces at/after the Safe's current nonce are executable — lower ones are dead (replaced/abandoned)
  // and the Safe app hides them. Filter server-side (also shrinks the response → fewer host errors).
  var current = await getSafeNextNonce(chainId, safe).catch(function () { return null; });
  var path = '/api/v1/safes/' + cs(safe) + '/multisig-transactions/?executed=false&trusted=true&ordering=nonce&limit=50' + (current != null ? ('&nonce__gte=' + current) : '');
  // Gateway first (base), then the legacy host as a fallback.
  var bases = [base, legacyBase(chainId)].filter(function (v, i, a) { return v && a.indexOf(v) === i; });
  var lastErr = null;
  for (var b = 0; b < bases.length; b++) {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var r = await safeFetch(bases[b] + path, { headers: headers(false) });
        if (r.ok) {
          var d = await r.json();
          var rows = (d && d.results) || [];
          if (current != null) rows = rows.filter(function (t) { return Number(t.nonce) >= current; }); // belt-and-suspenders
          return rows;
        }
        lastErr = new Error('Safe service ' + r.status);
      } catch (e) { lastErr = e; }
      if (attempt === 0) await new Promise(function (res) { setTimeout(res, 500); });
    }
  }
  throw lastErr || new Error('Safe service unavailable');
}

// Add the connected signer's confirmation to an already-queued tx (sign here instead of in the Safe app).
export async function confirmSafeTx(chainId, safe, tx, signer) {
  var base = txBase(chainId);
  if (!base) throw new Error('No Safe Transaction Service for this chain');
  // Reconstruct the SafeTx from the queued record and re-sign its hash.
  var fields = {
    to: tx.to, value: tx.value || 0, data: tx.data || '0x', operation: Number(tx.operation || 0),
    safeTxGas: tx.safeTxGas || 0, baseGas: tx.baseGas || 0, gasPrice: tx.gasPrice || 0,
    gasToken: tx.gasToken || ZERO, refundReceiver: tx.refundReceiver || ZERO, nonce: tx.nonce,
  };
  var signature = await signSafeTx(chainId, safe, fields, signer);
  var res = await safeFetch(base + '/api/v1/multisig-transactions/' + tx.safeTxHash + '/confirmations/', {
    method: 'POST', headers: headers(true), body: JSON.stringify({ signature: signature }),
  });
  if (!res.ok && res.status !== 201) {
    var detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error('Safe service ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  return true;
}

// Execute a queued tx that has enough confirmations, straight from the dapp (no Safe app needed).
// Assembles the owner signatures (sorted by owner address, as the Safe contract requires) and calls
// execTransaction on the Safe. The connected wallet sends it and pays gas; must be on `chainId`.
export var SAFE_EXEC_ABI = [{
  type: 'function', name: 'execTransaction', stateMutability: 'payable',
  inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' },
  ],
  outputs: [{ type: 'bool' }],
}];

// GnosisSafe.execTransaction args (shared by the direct-execute and Relayr-bundle paths). `signatures` is the
// owner sigs concatenated in ascending owner-address order (see execSignatures); gas fields default to 0.
export function safeExecArgs(tx, signatures) {
  return [cs(tx.to), BigInt(tx.value || 0), tx.data || '0x', Number(tx.operation || 0), BigInt(tx.safeTxGas || 0),
    BigInt(tx.baseGas || 0), BigInt(tx.gasPrice || 0), tx.gasToken || ZERO, tx.refundReceiver || ZERO, signatures];
}
// Signature bytes (no 0x) for one confirmation. A real offchain signature passes through; an onchain
// approveHash confirmation has a null signature, so synthesize Safe's pre-validated signature: r = the owner
// left-padded to 32 bytes, s = 0 (32 bytes), v = 1. Dropping these shifted owner recovery → GS026/GS020 revert.
function sigBytesFor(c) {
  var s = (c.signature || '').replace(/^0x/, '');
  if (s) return s;
  if (!c.owner) return null;
  var owner = (c.owner || '').replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return owner + '0'.repeat(64) + '01';
}
function sortedUsableConfirmations(tx) {
  return (tx.confirmations || []).slice()
    .filter(function (c) { return c && c.owner && !!sigBytesFor(c); })
    .sort(function (a, b) { return a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1; });
}
export function safeUsableConfirmationCount(tx) {
  return sortedUsableConfirmations(tx).length;
}
export function safeExecSignatures(tx) {
  return '0x' + sortedUsableConfirmations(tx).map(sigBytesFor).join('');
}

// A base-fee-buffered EIP-1559 fee cap. Some wallets under-estimate maxFeePerGas on L2s (e.g. set 0.02 gwei when
// the base fee just ticked to 0.0200056 gwei) and the RPC then rejects with "max fee per gas less than block base
// fee". Cap at 3× base + a small tip so a tick-up between estimate and submit can't reject the tx. Returns {} for
// non-EIP-1559 chains (let the wallet decide) or if the read fails — a hard-coded cap in either of those cases
// would be BELOW the base fee on any chain trading above it, turning an unknown into a guaranteed reject.
async function feeOverrides(chainId) {
  try {
    var pub = createPublicClientForChain(chainId);
    var block = await pub.getBlock();
    if (!block || block.baseFeePerGas == null) return {};
    var base = BigInt(block.baseFeePerGas);
    // A too-low priority tip (we shipped 0.002 gwei) reads as "underpriced": some wallet submission RPCs reject it
    // with an opaque -32603 "internal error" / "HTTP client error" rather than a clear message. Base/Arb Sepolia
    // base fees are ~0.005–0.02 gwei, so 0.05 gwei is a healthy, still-negligible tip.
    var tip = 50000000n; // 0.05 gwei priority
    // maxFeePerGas is a CAP (you only pay base + tip), so raising it never costs more — it only widens the window a
    // base-fee spike has to clear. Our RPC's base-fee reading can lag or differ from the wallet's SUBMISSION RPC, so
    // floor at 1 gwei (~200× the ~0.005 gwei Base Sepolia base fee): clears any transient spike or cross-RPC
    // disagreement at zero real cost. NOTE: this only covers fee-caused rejects — a genuinely broken/flaky wallet RPC
    // still fails; the fix there is switching the wallet's Base Sepolia RPC (e.g. to https://sepolia.base.org).
    var maxFee = base * 3n + tip;
    var floor = 1000000000n; // 1 gwei
    if (maxFee < floor) maxFee = floor;
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
  } catch (_) { return {}; }
}

// Send a Safe contract write with a buffered fee cap, then WAIT for the receipt so an onchain revert surfaces as
// an error (writeContract resolves on SUBMIT, not confirmation — a reverted tx would otherwise pass silently).
async function sendAndConfirm(wallet, chainId, params, label) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var account = getAccount();
  if (!account) throw new Error('Connect a wallet first');
  var active = await wallet.getChainId().catch(function () { return null; });
  if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  if (!wallet || !getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var pub = createPublicClientForChain(chainId);
  var simulation = await pub.simulateContract(Object.assign({ account: account }, params));
  if (label === 'execTransaction' && simulation.result !== true) throw new Error('Safe simulation reported that the queued transaction would fail. Nothing was sent.');
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var fees = await feeOverrides(chainId);
  var hash = await wallet.writeContract(Object.assign({}, simulation.request, { account: account, chain: CHAINS[chainId] }, fees));
  try {
    var rcpt = await pub.waitForTransactionReceipt({ hash: hash });
    if (rcpt && rcpt.status && rcpt.status !== 'success') throw new Error((label || 'Transaction') + ' reverted onchain (tx ' + hash + ').');
  } catch (e) {
    if (e && /reverted onchain/.test(e.message || '')) throw e; // genuine revert → propagate
    // receipt read failed (RPC hiccup) — return the hash anyway; the caller re-reads state to confirm.
  }
  return hash;
}

export async function executeSafeTx(chainId, safe, tx) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to execute.'); }
  // Safe requires signatures concatenated in ascending owner-address order.
  var confs = sortedUsableConfirmations(tx);
  if (!confs.length) throw new Error('No confirmations to execute with.');
  var signatures = '0x' + confs.map(sigBytesFor).join('');
  return sendAndConfirm(wallet, chainId, { address: cs(safe), abi: SAFE_EXEC_ABI, functionName: 'execTransaction', args: safeExecArgs(tx, signatures) }, 'execTransaction');
}
// A Relayr bundle entry that EXECUTES a ready Safe tx on its chain. execTransaction is permissionless
// (the owner signatures are embedded), so the relayer can send it — the user pays gas once for all chains.
export function safeExecRelayrTx(chainId, safe, tx) {
  var data = encodeFunctionData({
    abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
    args: safeExecArgs(tx, safeExecSignatures(tx)),
  });
  return { chain: Number(chainId), target: cs(safe), data: data, value: '0' };
}

// ── Onchain Safe path (no Transaction Service) ─────────────────────────────────────────────────────
// Some chains have no hosted Safe Transaction Service (e.g. Arbitrum/OP Sepolia). There's no offchain queue to
// post to, so signers coordinate ENTIRELY onchain: each owner calls approveHash(safeTxHash), and once the
// threshold is met anyone calls execTransaction with pre-validated "approved-hash" signatures (sigBytesFor above
// already synthesizes those for null-signature confirmations). This makes the operator/owner flow work on any
// chain where the Safe is deployed, regardless of Safe's API coverage.
var SAFE_ONCHAIN_ABI = [
  { type: 'function', name: 'approveHash', stateMutability: 'nonpayable', inputs: [{ name: 'hashToApprove', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'approvedHashes', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'hash', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];

// True when Safe's hosted Transaction Service covers this chain. False → use the onchain approveHash path.
export function hasSafeService(chainId) { return !!txBase(chainId); }

// Safes on `chainId` that `owner` signs for, via the Safe Transaction Service owners endpoint.
// Returns [] when the chain has no service; throws on a service error so callers can degrade.
export async function safesForOwner(owner, chainId) {
  var base = txBase(chainId);
  if (!base) return [];
  var res = await safeFetch(base + '/api/v1/owners/' + cs(owner) + '/safes/', { headers: headers(false) });
  if (!res.ok) throw new Error('Safe service HTTP ' + res.status);
  var body = await res.json();
  return Array.isArray(body && body.safes) ? body.safes : [];
}

// Deploy the SAME-address Safe on a chain the Safe app doesn't list, by replaying its original creation. The Safe
// address is CREATE2(factory, keccak(initializer)+saltNonce, singleton), so re-running createProxyWithNonce with the
// exact factory/singleton/initializer/saltNonce the Safe was first deployed with reproduces the identical address on
// any chain where that same factory+singleton exist (the canonical Safe deploys are on essentially every chain).
var PROXY_FACTORY_ABI = [{ type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable', inputs: [{ name: '_singleton', type: 'address' }, { name: 'initializer', type: 'bytes' }, { name: 'saltNonce', type: 'uint256' }], outputs: [{ type: 'address' }] }];

// Every chain this client can reach a hosted Safe Transaction Service on, TESTNETS FIRST. Derived from the
// service map (plus the localStorage override and the manifest's chains) rather than a hand-written list: the
// literal it replaced omitted Base Sepolia entirely, so a Safe that only exists on testnets could never have its
// creation record read. `hasSafeService` filters the rest, so a chain whose service 404s is never probed.
export function safeServiceChainIds() {
  var ids = {};
  function add(id) { var n = Number(id); if (Number.isFinite(n)) ids[n] = true; }
  Object.keys(SAFE_PREFIX).forEach(add);
  Object.keys(SAFE_TX_BASE).forEach(add);
  try {
    var override = JSON.parse(localStorage.getItem('jb-safe-tx-base') || 'null');
    if (override) Object.keys(override).forEach(add);
  } catch (_) {}
  chainList().forEach(function (c) { add(c.id); });
  // Same-address redeploys are overwhelmingly a testnet flow, and the creation record is chain-independent —
  // the first hit wins, so probing testnets first saves the mainnet round-trips.
  return Object.keys(ids).map(Number).filter(hasSafeService)
    .sort(function (a, b) { return (isTestnetChain(a) ? 0 : 1) - (isTestnetChain(b) ? 0 : 1); });
}

// Read the Safe's original creation params from the tx-service of ANY chain where it already exists (params are
// chain-independent). Public endpoint (no key required); the address MUST be checksummed or it 422s.
export async function fetchSafeCreation(safe) {
  var candidates = safeServiceChainIds();
  for (var i = 0; i < candidates.length; i++) {
    var base = txBase(candidates[i]); if (!base) continue;
    try {
      var res = await fetch(base + '/api/v1/safes/' + cs(safe) + '/creation/', { headers: headers(false) });
      if (!res.ok) continue;
      var j = await res.json();
      if (j && j.factoryAddress && j.masterCopy && j.setupData) {
        return { factory: cs(j.factoryAddress), singleton: cs(j.masterCopy), initializer: j.setupData, saltNonce: BigInt(j.saltNonce || 0) };
      }
    } catch (_) {}
  }
  return null;
}

// Deploy the same-address Safe on `chainId` from a fetched creation record, then verify it actually landed at the
// expected address (a differing factory/singleton on the target chain would produce a different address).
export async function deploySafeSameAddress(chainId, creation, expectedSafe) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to deploy.'); }
  var hash = await sendAndConfirm(wallet, chainId, { address: cs(creation.factory), abi: PROXY_FACTORY_ABI, functionName: 'createProxyWithNonce', args: [cs(creation.singleton), creation.initializer, creation.saltNonce] }, 'createProxyWithNonce');
  // Verify the Safe landed at the expected address — but RETRY, because a flaky RPC (Base/OP Sepolia especially) can
  // return empty code for a just-deployed contract and produce a false "did not land". Only fail after several misses.
  var pub = createPublicClientForChain(chainId), code = null;
  for (var attempt = 0; attempt < 6; attempt++) {
    code = await pub.getBytecode({ address: cs(expectedSafe) }).catch(function () { return null; });
    if (code && code !== '0x') break;
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  if (!code || code === '0x') throw new Error('Deployed, but the Safe isn’t readable at ' + expectedSafe + ' yet — the RPC may be lagging. Reload to check; if it stays missing, the factory/singleton on this chain differ from the original.');
  return hash;
}

// The SafeTx hash for a {to, data, value, nonce} call — what signers approve and what execTransaction must match.
export function safeTxHashForCall(chainId, safe, call) {
  return safeTxHashOf(chainId, safe, {
    to: call.to, value: call.value || 0, data: call.data || '0x', operation: 0,
    safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: call.nonce,
  });
}

// Read the Safe's onchain params (nonce / threshold / owners) directly — no Transaction Service.
export async function safeOnChainContext(chainId, safe) {
  var pub = createPublicClientForChain(chainId);
  var r = await Promise.all([
    pub.readContract({ address: safe, abi: SAFE_ONCHAIN_ABI, functionName: 'nonce', args: [] }),
    pub.readContract({ address: safe, abi: SAFE_ONCHAIN_ABI, functionName: 'getThreshold', args: [] }),
    pub.readContract({ address: safe, abi: SAFE_ONCHAIN_ABI, functionName: 'getOwners', args: [] }),
  ]);
  return { nonce: Number(r[0]), threshold: Number(r[1]), owners: r[2] || [] };
}

// Which of `owners` have approved `hash` onchain (approvedHashes == 1). Returns the approved owner addresses.
export async function safeApprovalsOf(chainId, safe, hash, owners) {
  var pub = createPublicClientForChain(chainId);
  var flags = await Promise.all((owners || []).map(function (o) {
    return pub.readContract({ address: safe, abi: SAFE_ONCHAIN_ABI, functionName: 'approvedHashes', args: [o, hash] })
      .then(function (v) { return BigInt(v) > 0n; }).catch(function () { return false; });
  }));
  return (owners || []).filter(function (o, i) { return flags[i]; });
}

// Approve a SafeTx hash onchain from the connected signer (records approvedHashes[signer][hash] = 1). The wallet
// must be on `chainId` and be a Safe owner. Returns the approveHash tx hash.
export async function approveSafeHashOnChain(chainId, safe, hash) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to approve.'); }
  return sendAndConfirm(wallet, chainId, { address: cs(safe), abi: SAFE_ONCHAIN_ABI, functionName: 'approveHash', args: [hash] }, 'approveHash');
}

export { SAFE_PREFIX };
