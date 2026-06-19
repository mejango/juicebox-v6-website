// src/safe.js
// Safe (multisig) support for owner/operator-gated actions. When a project owner is a Safe, we can't
// route through Relayr (a Safe has no private key to sign an ERC-2771 forward request). Instead we
// PROPOSE the call to the Safe Transaction Service on each chain — it lands in the Safe's queue, and the
// Safe's signers confirm + execute (from the Safe app, or from our Back office tab).
//
// Caveats (flagged for live testing): the per-network Safe Transaction Service endpoints below may
// require an API key and/or restrict browser CORS depending on Safe's current API policy. The base URL
// and an optional API key are configurable (localStorage) so this can be pointed at a working endpoint
// without a rebuild; every call degrades gracefully (throws a readable error) so the UI can fall back to
// the "Open in Safe app" deep link.

import { hashTypedData, getAddress as checksumAddress, encodeFunctionData } from 'viem';
import { getWalletClient, getAccount, switchChain, createPublicClientForChain } from './component-base.js';
import { CHAINS } from './chain.js';

var ZERO = '0x0000000000000000000000000000000000000000';
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
// Safe app chain shortNames for deep links (https://app.safe.global).
var SAFE_PREFIX = { 1: 'eth', 10: 'oeth', 8453: 'base', 42161: 'arb1', 11155111: 'sep' };

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
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) {
    if (e && e.code === 4001) throw e;
    throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to sign.');
  }
  return wallet.signTypedData({
    account: signer, domain: { chainId: Number(chainId), verifyingContract: safe },
    types: SAFE_TX_TYPES, primaryType: 'SafeTx', message: safeTxMessage(fields),
  });
}

// The Safe's current queue nonce (next nonce to use). Reads the service; falls back to on-chain `nonce()`.
export async function getSafeNextNonce(chainId, safe) {
  var base = txBase(chainId);
  if (base) {
    try {
      var r = await fetch(base + '/api/v1/safes/' + cs(safe) + '/', { headers: headers(false) });
      if (r.ok) { var d = await r.json(); if (d && d.nonce != null) return Number(d.nonce); }
    } catch (_) {}
  }
  // On-chain fallback.
  try {
    var pub = createPublicClientForChain(chainId);
    var n = await pub.readContract({ address: safe, abi: [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }], functionName: 'nonce', args: [] });
    return Number(n);
  } catch (_) { return null; }
}

// Propose a transaction to the Safe's queue on `chainId`. Returns { safeTxHash, nonce }.
export async function proposeSafeTx(opts) {
  // opts: { chainId, safe, to, data, value, signer }
  var base = txBase(opts.chainId);
  if (!base) throw new Error('No Safe Transaction Service configured for ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId));
  // Caller may pick the nonce (e.g. to replace a queued tx); otherwise use the recommended next nonce.
  var nonce = (opts.nonce != null) ? Number(opts.nonce) : await getSafeNextNonce(opts.chainId, opts.safe);
  if (nonce == null) throw new Error('Could not read the Safe nonce on ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId));
  var fields = { to: opts.to, value: opts.value || 0, data: opts.data || '0x', operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: nonce };
  var safeTxHash = safeTxHashOf(opts.chainId, opts.safe, fields);
  var signature = await signSafeTx(opts.chainId, opts.safe, fields, opts.signer);
  var body = {
    to: cs(fields.to), value: String(fields.value), data: fields.data, operation: 0,
    safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO,
    nonce: String(nonce), contractTransactionHash: safeTxHash, sender: cs(opts.signer),
    signature: signature, origin: 'Juicebox V6 explorer',
  };
  var res = await fetch(base + '/api/v1/safes/' + cs(opts.safe) + '/multisig-transactions/', {
    method: 'POST', headers: headers(true), body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 201) {
    var detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error('Safe service ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  return { safeTxHash: safeTxHash, nonce: nonce };
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
        var r = await fetch(bases[b] + path, { headers: headers(false) });
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
  var res = await fetch(base + '/api/v1/multisig-transactions/' + tx.safeTxHash + '/confirmations/', {
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
var SAFE_EXEC_ABI = [{
  type: 'function', name: 'execTransaction', stateMutability: 'payable',
  inputs: [
    { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' },
    { name: 'signatures', type: 'bytes' },
  ],
  outputs: [{ type: 'bool' }],
}];
export async function executeSafeTx(chainId, safe, tx) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to execute.'); }
  // Safe requires signatures concatenated in ascending owner-address order.
  var confs = (tx.confirmations || []).slice().sort(function (a, b) { return a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1; });
  if (!confs.length) throw new Error('No confirmations to execute with.');
  var signatures = '0x' + confs.map(function (c) { return (c.signature || '').replace(/^0x/, ''); }).join('');
  return wallet.writeContract({
    account: getAccount(), chain: CHAINS[chainId], address: cs(safe), abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
    args: [cs(tx.to), BigInt(tx.value || 0), tx.data || '0x', Number(tx.operation || 0), BigInt(tx.safeTxGas || 0), BigInt(tx.baseGas || 0), BigInt(tx.gasPrice || 0), tx.gasToken || ZERO, tx.refundReceiver || ZERO, signatures],
  });
}

// The signatures bytes for a ready tx (owner sigs concatenated, ASC by owner address).
function execSignatures(tx) {
  var confs = (tx.confirmations || []).slice().sort(function (a, b) { return a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1; });
  return '0x' + confs.map(function (c) { return (c.signature || '').replace(/^0x/, ''); }).join('');
}
// A Relayr bundle entry that EXECUTES a ready Safe tx on its chain. execTransaction is permissionless
// (the owner signatures are embedded), so the relayer can send it — the user pays gas once for all chains.
export function safeExecRelayrTx(chainId, safe, tx) {
  var data = encodeFunctionData({
    abi: SAFE_EXEC_ABI, functionName: 'execTransaction',
    args: [cs(tx.to), BigInt(tx.value || 0), tx.data || '0x', Number(tx.operation || 0), BigInt(tx.safeTxGas || 0), BigInt(tx.baseGas || 0), BigInt(tx.gasPrice || 0), tx.gasToken || ZERO, tx.refundReceiver || ZERO, execSignatures(tx)],
  });
  return { chain: Number(chainId), target: cs(safe), data: data, value: '0' };
}

export { SAFE_PREFIX };
