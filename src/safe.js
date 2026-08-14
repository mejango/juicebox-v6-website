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

import { hashTypedData, getAddress as checksumAddress, encodeFunctionData, decodeFunctionData, decodeFunctionResult, keccak256, stringToHex } from 'viem';
import { getWalletClient, getAccount, switchChain, createPublicClientForChain, ZERO_ADDRESS as ZERO, getViewAs, VIEW_AS_TX_ERROR } from './component-base.js';
import { CHAINS, chainList, isTestnetChain } from './chain.js';
import { contractGasWithinCap } from './gas.js';

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
    function nonceNumber(value) {
      var nonce;
      try { nonce = BigInt(value); } catch (_) { return null; }
      return nonce >= 0n && nonce <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(nonce) : null;
    }
    var base = txBase(chainId);
    if (base) {
      try {
        var r = await safeFetch(base + '/api/v1/safes/' + cs(safe) + '/', { headers: headers(false) });
        if (r.ok) { var d = await r.json(); if (d && d.nonce != null) { var serviceNonce = nonceNumber(d.nonce); if (serviceNonce != null) return serviceNonce; } }
      } catch (_) {}
    }
    // Onchain fallback.
    try {
      var pub = createPublicClientForChain(chainId);
      return nonceNumber(await readSafeUintBounded(pub, safe, 'nonce'));
    } catch (_) { return null; }
  })();
  _nonceInflight[key] = p;
  p.then(function () { delete _nonceInflight[key]; }, function () { delete _nonceInflight[key]; });
  return p;
}

// Propose a transaction to the Safe's queue on `chainId`. Returns { safeTxHash, nonce }.
export async function proposeSafeTx(opts) {
  // opts: { chainId, safe, to, data, value, signer, reverify? }. `reverify` runs after the wallet
  // signature and immediately before the service write so a Safe owner/threshold rotation while the wallet
  // prompt is open cannot post a signature authorized only by stale governance.
  var base = txBase(opts.chainId);
  if (!base) throw new Error('No Safe Transaction Service configured for ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId));
  // Caller may pick the nonce (e.g. to replace a queued tx); otherwise use the recommended next nonce.
  var nonce = (opts.nonce != null) ? Number(opts.nonce) : await getSafeNextNonce(opts.chainId, opts.safe);
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Could not read a valid Safe nonce on ' + ((CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || opts.chainId) + '.');
  var fields = { to: opts.to, value: opts.value || 0, data: opts.data || '0x', operation: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: nonce };
  var safeTxHash = safeTxHashOf(opts.chainId, opts.safe, fields);
  var signature = await signSafeTx(opts.chainId, opts.safe, fields, opts.signer);
  if (opts.reverify) await opts.reverify();
  if (!getAccount() || getAccount().toLowerCase() !== opts.signer.toLowerCase()) throw new Error('Connected account changed. Review the Safe transaction again.');
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
export async function confirmSafeTx(chainId, safe, tx, signer, reverify) {
  var base = txBase(chainId);
  if (!base) throw new Error('No Safe Transaction Service for this chain');
  // Reconstruct the SafeTx from the queued record and re-sign its hash.
  var fields = {
    to: tx.to, value: tx.value || 0, data: tx.data || '0x', operation: Number(tx.operation || 0),
    safeTxGas: tx.safeTxGas || 0, baseGas: tx.baseGas || 0, gasPrice: tx.gasPrice || 0,
    gasToken: tx.gasToken || ZERO, refundReceiver: tx.refundReceiver || ZERO, nonce: tx.nonce,
  };
  var signature = await signSafeTx(chainId, safe, fields, signer);
  if (reverify) await reverify();
  if (!getAccount() || getAccount().toLowerCase() !== signer.toLowerCase()) throw new Error('Connected account changed. Review the Safe transaction again.');
  var res = await safeFetch(base + '/api/v1/multisig-transactions/' + tx.safeTxHash + '/confirmations/', {
    method: 'POST', headers: headers(true), body: JSON.stringify({ signature: signature }),
  });
  if (!res.ok && res.status !== 201) {
    var detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error('Safe service ' + res.status + (detail ? ': ' + detail.slice(0, 200) : ''));
  }
  // Returning the exact signature lets a resumable caller update its in-memory view immediately after the
  // service accepts the confirmation, without relying on eventually-consistent queue indexing.
  return signature;
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
// approveHash confirmation has a null signature, so synthesize Safe's pre-validated signature only after the
// caller has proven approvedHashes(owner, hash) onchain and marked it `approvedHash:true`: r = the owner
// left-padded to 32 bytes, s = 0 (32 bytes), v = 1. A service-side null alone is not proof — v=1 also accepts
// msg.sender==owner, which can make an owner-origin eth_call pass even though a later relayer would revert.
function sigBytesFor(c) {
  var s = (c.signature || '').replace(/^0x/, '');
  if (s) return s;
  if (!c.owner || c.approvedHash !== true) return null;
  var owner = (c.owner || '').replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return owner + '0'.repeat(64) + '01';
}
function sortedUsableConfirmations(tx, allowedOwners) {
  var allowed = Array.isArray(allowedOwners)
    ? new Set(allowedOwners.map(function (owner) { return String(owner).toLowerCase(); }))
    : null;
  var seen = new Set();
  return (tx.confirmations || []).slice()
    .filter(function (c) {
      var owner = c && c.owner && String(c.owner).toLowerCase();
      if (!owner || !sigBytesFor(c) || seen.has(owner) || (allowed && !allowed.has(owner))) return false;
      seen.add(owner); return true;
    })
    .sort(function (a, b) { return a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1; });
}
export function safeUsableConfirmationCount(tx, allowedOwners) {
  return sortedUsableConfirmations(tx, allowedOwners).length;
}
export function safeExecSignatures(tx, allowedOwners) {
  return '0x' + sortedUsableConfirmations(tx, allowedOwners).map(sigBytesFor).join('');
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
async function sendAndConfirm(wallet, chainId, params, label, expectedResultAddress, reverify, verifyReceipt) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var account = getAccount();
  if (!account) throw new Error('Connect a wallet first');
  var active = await wallet.getChainId().catch(function () { return null; });
  if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  if (!wallet || !getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var pub = createPublicClientForChain(chainId);
  if (reverify) await reverify();
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var calldata = encodeFunctionData({ abi: params.abi, functionName: params.functionName, args: params.args || [] });
  var value = BigInt(params.value || 0);
  var gas = label === 'approveHash' ? 300000n : 5000000n;
  var rawTx = {
    from: account, to: params.address, data: calldata,
    value: '0x' + value.toString(16), gas: '0x' + gas.toString(16),
  };
  // The proxy/singleton is an authority-controlled contract. Use raw eth_call with a hard gas and returndata cap;
  // Viem simulateContract may follow OffchainLookup and fetch an attacker-selected URL before our identity check.
  var rawResult = await pub.request({ method: 'eth_call', params: [rawTx, 'latest'] });
  if (typeof rawResult !== 'string' || !/^0x[0-9a-f]*$/i.test(rawResult) || rawResult.length > 258) {
    throw new Error('Safe simulation returned malformed or oversized data. Nothing was sent.');
  }
  var simulationResult;
  try { simulationResult = decodeFunctionResult({ abi: params.abi, functionName: params.functionName, data: rawResult }); }
  catch (_) {
    // No-output writes (approveHash) canonically return empty bytes.
    if (rawResult !== '0x') throw new Error('Safe simulation returned unexpected data. Nothing was sent.');
  }
  if (label === 'execTransaction' && simulationResult !== true) throw new Error('Safe simulation reported that the queued transaction would fail. Nothing was sent.');
  if (expectedResultAddress) {
    var simulatedAddress = null;
    try { simulatedAddress = checksumAddress(simulationResult).toLowerCase(); } catch (_) {}
    if (simulatedAddress !== checksumAddress(expectedResultAddress).toLowerCase()) {
      throw new Error('Safe factory simulation returned an unexpected proxy address. Nothing was sent.');
    }
  }
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var fees = await feeOverrides(chainId);
  // The cap above bounds the simulation, not the cost: sending 5M gas makes the
  // wallet reserve ~$14 of mainnet ETH for an execution that costs a fraction.
  var sendGas = await contractGasWithinCap(pub, Object.assign({}, params, { account: account }), gas);
  if (reverify) await reverify();
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the transaction again.');
  var hash = await wallet.writeContract(Object.assign({}, params, { account: account, chain: CHAINS[chainId], gas: sendGas }, fees));
  try {
    var rcpt = await pub.waitForTransactionReceipt({ hash: hash });
    if (!rcpt) throw new Error('Receipt unavailable.');
    if (rcpt.status !== 'success') throw new Error((label || 'Transaction') + ' reverted onchain (tx ' + hash + ').');
    if (verifyReceipt) await verifyReceipt(rcpt);
  } catch (e) {
    if (e && /reverted onchain/.test(e.message || '')) throw e; // genuine revert → propagate
    if (e && e.code === 'SAFE_EXECUTION_NOT_CONFIRMED') throw e;
    // A submitted hash is not execution. Fail as an explicitly uncertain outcome so callers cannot label a
    // dropped/pending/reverted Safe write "Executed" or advance a sequential batch without a successful receipt.
    var uncertain = new Error((label || 'Safe transaction') + ' was submitted as ' + hash + ', but its successful receipt could not be verified. Check this exact hash before trying again.');
    uncertain.code = 'SAFE_TX_SUBMITTED'; uncertain.hash = hash; uncertain.cause = e;
    throw uncertain;
  }
  return hash;
}

export async function executeSafeTx(chainId, safe, tx, reverify) {
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
  var expectedSafeTxHash = safeTxHashForQueuedTx(chainId, safe, tx);
  return sendAndConfirm(wallet, chainId, { address: cs(safe), abi: SAFE_EXEC_ABI, functionName: 'execTransaction', args: safeExecArgs(tx, signatures) }, 'execTransaction', null, reverify, function (receipt) {
    if (!hasExactSafeExecutionSuccess(receipt.logs, safe, expectedSafeTxHash)) {
      var failure = new Error('Safe execTransaction mined without ExecutionSuccess for the reviewed transaction (tx ' + receipt.transactionHash + ').');
      failure.code = 'SAFE_EXECUTION_NOT_CONFIRMED';
      throw failure;
    }
  });
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

// Recover the exact Safe transaction represented by a Relayr outer execTransaction call. The nonce is not an
// execTransaction argument, so durable Relayr receipts persist it alongside the canonical SafeTx hash. Re-encode
// byte-for-byte to reject trailing or ambiguous calldata before using the decoded inner call as a postcondition.
export function decodeSafeExecRelayrTx(chainId, safe, data, nonce) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data) || (data.length - 2) / 2 > 131072) {
    throw new Error('The persisted Safe execution calldata is malformed or oversized.');
  }
  var decoded;
  try { decoded = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: data }); }
  catch (_) { throw new Error('The persisted Relayr call is not a Safe execTransaction.'); }
  if (!decoded || decoded.functionName !== 'execTransaction' || !decoded.args || decoded.args.length !== 10) {
    throw new Error('The persisted Relayr call is not a Safe execTransaction.');
  }
  var canonical = encodeFunctionData({ abi: SAFE_EXEC_ABI, functionName: 'execTransaction', args: decoded.args });
  if (canonical.toLowerCase() !== data.toLowerCase()) throw new Error('The persisted Safe execution calldata is not canonical.');
  var safeNonce;
  try { safeNonce = BigInt(nonce); }
  catch (_) { throw new Error('The persisted Safe execution nonce is malformed.'); }
  if (safeNonce < 0n || safeNonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('The persisted Safe execution nonce is out of range.');
  var tx = {
    to: decoded.args[0], value: decoded.args[1], data: decoded.args[2], operation: Number(decoded.args[3]),
    safeTxGas: decoded.args[4], baseGas: decoded.args[5], gasPrice: decoded.args[6], gasToken: decoded.args[7],
    refundReceiver: decoded.args[8], nonce: Number(safeNonce), confirmations: [],
  };
  return { tx: tx, signatures: decoded.args[9], safeTxHash: safeTxHashForQueuedTx(chainId, safe, tx) };
}

export var SAFE_EXECUTION_SUCCESS_TOPIC = keccak256(stringToHex('ExecutionSuccess(bytes32,uint256)'));
export var SAFE_EXECUTION_FAILURE_TOPIC = keccak256(stringToHex('ExecutionFailure(bytes32,uint256)'));

// Safe 1.3 emitted txHash as the first unindexed data word; Safe 1.4 indexes it. Require the exact canonical
// layout and zero payment (Juicescan only executes zero-refund queued transactions), never just a successful
// outer EVM receipt: Safe.execTransaction can return false and emit ExecutionFailure without reverting.
export function hasExactSafeExecutionSuccess(logs, safe, safeTxHash) {
  var expectedSafe = String(safe || '').toLowerCase();
  var expectedHash = String(safeTxHash || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(expectedSafe) || !/^0x[0-9a-f]{64}$/.test(expectedHash)) return false;
  return (Array.isArray(logs) ? logs : []).some(function (log) {
    if (!log || String(log.address || '').toLowerCase() !== expectedSafe || !Array.isArray(log.topics)) return false;
    var topics = log.topics.map(function (topic) { return String(topic || '').toLowerCase(); });
    var data = String(log.data || '').toLowerCase();
    if (topics[0] !== SAFE_EXECUTION_SUCCESS_TOPIC.toLowerCase()) return false;
    if (topics.length === 2 && data === '0x' + '0'.repeat(64)) return topics[1] === expectedHash;
    return topics.length === 1 && data === expectedHash + '0'.repeat(64);
  });
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

// Safe proxy views execute through the singleton. Keep every read bounded and disable CCIP-read so an
// untrusted/malformed proxy cannot turn a Safe check into unbounded RPC work or return-data decoding. Fifty
// owners is also the largest Safe this client will attempt to coordinate or replay across chains.
export var SAFE_MAX_OWNERS = 50;
var SAFE_VIEW_GAS = 300000n;
var SAFE_FIXED_RETURN_BYTES = 32;
var SAFE_VERSION_RETURN_BYTES = 128;
var SAFE_MODULE_PAGE_RETURN_BYTES = 128;

async function boundedSafeCall(client, safe, abi, functionName, args, maxBytes, label) {
  if (!client || typeof client.request !== 'function') throw new Error('The RPC client cannot make bounded Safe calls.');
  var data = encodeFunctionData({ abi: abi, functionName: functionName, args: args || [] });
  var raw = await client.request({
    method: 'eth_call', params: [{
      to: cs(safe), data: data, gas: '0x' + SAFE_VIEW_GAS.toString(16),
    }, 'latest'],
  });
  if (typeof raw !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(raw)) {
    throw new Error((label || functionName) + ' returned malformed data.');
  }
  var bytes = (raw.length - 2) / 2;
  if (!bytes || bytes > maxBytes) throw new Error((label || functionName) + ' returned oversized data.');
  return raw;
}

export async function readSafeOwnersBounded(client, safe) {
  // address[] return encoding is: offset (32), count (32), then one padded word per owner. Inspect both
  // dynamic words and the exact total size before asking a generic ABI decoder to allocate the array.
  var maxBytes = 64 + SAFE_MAX_OWNERS * 32;
  var raw = await boundedSafeCall(client, safe, SAFE_ONCHAIN_ABI, 'getOwners', [], maxBytes, 'Safe getOwners');
  var body = raw.slice(2);
  if (body.length < 128 || BigInt('0x' + body.slice(0, 64)) !== 32n) {
    throw new Error('Safe getOwners returned malformed data.');
  }
  var count = BigInt('0x' + body.slice(64, 128));
  if (count > BigInt(SAFE_MAX_OWNERS)) throw new Error('Safe has too many owners for this client.');
  if (count > BigInt(Number.MAX_SAFE_INTEGER) || body.length !== Number(128n + count * 64n)) {
    throw new Error('Safe getOwners returned malformed data.');
  }
  var owners = [];
  for (var i = 0; i < Number(count); i++) {
    var word = body.slice(128 + i * 64, 192 + i * 64);
    if (!/^0{24}[0-9a-f]{40}$/i.test(word)) throw new Error('Safe getOwners returned malformed data.');
    owners.push(cs('0x' + word.slice(24)));
  }
  return owners;
}

export async function readSafeUintBounded(client, safe, functionName, args) {
  var raw = await boundedSafeCall(client, safe, SAFE_ONCHAIN_ABI, functionName, args || [], SAFE_FIXED_RETURN_BYTES, 'Safe ' + functionName);
  if (raw.length !== 66) throw new Error('Safe ' + functionName + ' returned malformed data.');
  return decodeFunctionResult({ abi: SAFE_ONCHAIN_ABI, functionName: functionName, data: raw });
}

export async function readSafeMasterCopyBounded(client, safe) {
  var raw = await boundedSafeCall(client, safe, SAFE_DEPLOYMENT_POLICY_ABI, 'masterCopy', [], SAFE_FIXED_RETURN_BYTES, 'Safe masterCopy');
  if (raw.length !== 66) throw new Error('Safe masterCopy returned malformed data.');
  return decodeFunctionResult({ abi: SAFE_DEPLOYMENT_POLICY_ABI, functionName: 'masterCopy', data: raw });
}

export async function readSafeVersionBounded(client, safe) {
  var raw = await boundedSafeCall(client, safe, SAFE_DEPLOYMENT_POLICY_ABI, 'VERSION', [], SAFE_VERSION_RETURN_BYTES, 'Safe VERSION');
  return decodeFunctionResult({ abi: SAFE_DEPLOYMENT_POLICY_ABI, functionName: 'VERSION', data: raw });
}

export async function readSafeModulesBounded(client, safe) {
  var args = [SAFE_MODULES_SENTINEL, 1n];
  var raw = await boundedSafeCall(client, safe, SAFE_DEPLOYMENT_POLICY_ABI, 'getModulesPaginated', args, SAFE_MODULE_PAGE_RETURN_BYTES, 'Safe modules');
  return decodeFunctionResult({ abi: SAFE_DEPLOYMENT_POLICY_ABI, functionName: 'getModulesPaginated', data: raw });
}

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
var SAFE_MODULES_SENTINEL = '0x0000000000000000000000000000000000000001';
var SAFE_SINGLETON_STORAGE_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';
var SAFE_GUARD_STORAGE_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
var SAFE_FALLBACK_HANDLER_STORAGE_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
var RECOGNIZED_SAFE_PROXY_CODE_HASHES = {
  '0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000': true,
  '0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c': true,
};
var RECOGNIZED_SAFE_RELEASES = [
  {
    version: '1.3.0',
    singletons: [
      '0xd9db270c1b5e3bd161e8c8503c55ceabee709552', '0x69f4d1788e39c87893c980c06edf4b7f686e2938',
      '0x3e5c63644e683549055b9be8653de26e0b4cd36e', '0xfb1bffc9d739b8d520daf37df666da4c687191ea',
    ],
    factories: ['0xa6b71e26c5e0845f74c812102ca7114b6a896ab2', '0xc22834581ebc8527d974f8a1c97e1bea4ef910bc'],
  },
  {
    version: '1.4.1',
    singletons: ['0x41675c099f32341bf84bfc5382af534df5c7461a', '0x29fcb43b46531bca003ddc8fcb67ffe91900c762'],
    factories: ['0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67'],
  },
];
export var SAFE_SETUP_ABI = [{
  type: 'function', name: 'setup', stateMutability: 'nonpayable',
  inputs: [
    { name: '_owners', type: 'address[]' }, { name: '_threshold', type: 'uint256' },
    { name: 'to', type: 'address' }, { name: 'data', type: 'bytes' },
    { name: 'fallbackHandler', type: 'address' }, { name: 'paymentToken', type: 'address' },
    { name: 'payment', type: 'uint256' }, { name: 'paymentReceiver', type: 'address' },
  ],
  outputs: [],
}];
var SAFE_DEPLOYMENT_POLICY_ABI = SAFE_ONCHAIN_ABI.concat([{
  type: 'function', name: 'getModulesPaginated', stateMutability: 'view',
  inputs: [{ name: 'start', type: 'address' }, { name: 'pageSize', type: 'uint256' }],
  outputs: [{ name: 'array', type: 'address[]' }, { name: 'next', type: 'address' }],
}, {
  type: 'function', name: 'masterCopy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }],
}, {
  type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }],
}]);

function safeReleaseForSingleton(singleton) {
  var normalized;
  try { normalized = checksumAddress(singleton).toLowerCase(); } catch (_) { return null; }
  return RECOGNIZED_SAFE_RELEASES.find(function (release) { return release.singletons.indexOf(normalized) >= 0; }) || null;
}

function isRecognizedSafeFactoryPair(factory, singleton) {
  var release = safeReleaseForSingleton(singleton), normalizedFactory;
  try { normalizedFactory = checksumAddress(factory).toLowerCase(); } catch (_) { return false; }
  return !!release && release.factories.indexOf(normalizedFactory) >= 0;
}

// Normalize every RPC bytecode result before hashing/comparing it. Odd-length, non-hex, and truncated values are
// verification failures rather than evidence that an address is an EOA or that two implementations match.
function normalizedRuntimeCode(code, required, label) {
  if (code === undefined || code === '0x') {
    if (required) throw new Error('Could not read ' + (label || 'contract') + ' bytecode.');
    return null;
  }
  if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/i.test(code)) {
    throw new Error((label || 'Contract') + ' returned malformed bytecode.');
  }
  return code.toLowerCase();
}

// EIP-7702-delegated accounts remain key-controlled EOAs. Only the protocol's exact 23-byte designator is
// EOA-like; a normal runtime which happens to share the prefix must continue to fail the contract-owner gate.
function isEip7702DelegatedEoaRuntime(code) {
  return typeof code === 'string' && /^0xef0100[0-9a-f]{40}$/i.test(code);
}

function normalizedSafeGovernance(governance, label) {
  var owners = governance && governance.owners;
  if (!Array.isArray(owners) || !owners.length || owners.length > SAFE_MAX_OWNERS) throw new Error((label || 'Safe') + ' has no readable owners.');
  var normalized = owners.map(function (owner) {
    try {
      var address = checksumAddress(owner).toLowerCase();
      if (address === ZERO.toLowerCase()) throw new Error('zero owner');
      return address;
    }
    catch (_) { throw new Error((label || 'Safe') + ' returned an invalid owner address.'); }
  }).sort();
  if (normalized.some(function (owner, index) { return index && owner === normalized[index - 1]; })) {
    throw new Error((label || 'Safe') + ' returned duplicate owners.');
  }
  var threshold;
  try { threshold = BigInt(governance.threshold); }
  catch (_) { throw new Error((label || 'Safe') + ' has an invalid threshold.'); }
  if (threshold < 1n || threshold > BigInt(normalized.length)) throw new Error((label || 'Safe') + ' has an invalid threshold.');
  return { owners: normalized, threshold: threshold };
}

function sameSafeGovernance(a, b) {
  var aa = normalizedSafeGovernance(a, 'First Safe');
  var bb = normalizedSafeGovernance(b, 'Second Safe');
  return aa.threshold === bb.threshold && aa.owners.length === bb.owners.length && aa.owners.every(function (owner, i) { return owner === bb.owners[i]; });
}

function decodeSafeSetupInitializer(initializer) {
  var decoded;
  try { decoded = decodeFunctionData({ abi: SAFE_SETUP_ABI, data: initializer }); }
  catch (_) { throw new Error('The Safe creation initializer is not a valid Safe setup call.'); }
  if (!decoded || decoded.functionName !== 'setup' || !decoded.args || decoded.args.length !== 8) {
    throw new Error('The Safe creation initializer is not a valid Safe setup call.');
  }
  try {
    var canonical = encodeFunctionData({ abi: SAFE_SETUP_ABI, functionName: 'setup', args: decoded.args });
    if (canonical.toLowerCase() !== String(initializer).toLowerCase()) throw new Error('noncanonical setup');
  } catch (_) { throw new Error('The Safe creation initializer is not a canonical Safe setup call.'); }
  return decoded.args;
}

function verifyDecodedSafeSetup(args, sourceGovernance) {
  var owners = args[0], threshold = args[1], delegateTarget = args[2], delegateData = args[3];
  var paymentToken = args[5], payment = args[6], paymentReceiver = args[7];
  if (String(delegateTarget).toLowerCase() !== ZERO.toLowerCase() || String(delegateData).toLowerCase() !== '0x') {
    throw new Error('This Safe was created with a delegate setup/module initializer, so automatic same-address deployment is unsafe. Deploy it through Safe instead.');
  }
  // setup() can also pay an arbitrary receiver. Replaying a non-zero payment could drain assets prefunded to the
  // deterministic address before deployment, so it is outside the safe automatic replay subset.
  if (String(paymentToken).toLowerCase() !== ZERO.toLowerCase() || BigInt(payment || 0) !== 0n
      || String(paymentReceiver).toLowerCase() !== ZERO.toLowerCase()) {
    throw new Error('This Safe was created with a setup payment, so automatic same-address deployment is unsafe. Deploy it through Safe instead.');
  }
  var initializerGovernance = { owners: owners, threshold: threshold };
  if (!sameSafeGovernance(initializerGovernance, sourceGovernance)) {
    throw new Error('The Safe’s current owners or threshold differ from its creation initializer. Replaying it would restore stale governance, so deployment was stopped.');
  }
  return { owners: owners.slice(), threshold: Number(threshold), fallbackHandler: args[4] };
}

// Fail closed before replaying an initializer. A Safe's CREATE2 address commits to its ORIGINAL setup calldata,
// not its current policy. If owners or threshold have changed since creation, replaying that calldata would deploy
// a same-address Safe controlled by stale signers. A setup delegatecall can also install modules or mutate arbitrary
// Safe storage, so only the plain setup form is eligible for automatic cross-chain deployment.
export function verifySafeCreationGovernance(initializer, sourceGovernance) {
  var verified = verifyDecodedSafeSetup(decodeSafeSetupInitializer(initializer), sourceGovernance);
  return { owners: verified.owners, threshold: verified.threshold };
}

function normalizedAddress(value, label) {
  try { return checksumAddress(value).toLowerCase(); }
  catch (_) { throw new Error((label || 'Safe address') + ' is malformed.'); }
}

function addressFromStorageWord(word, label) {
  if (typeof word !== 'string' || !/^0x0{24}[0-9a-f]{40}$/i.test(word)) {
    throw new Error('Could not verify ' + (label || 'the Safe storage address') + '.');
  }
  return normalizedAddress('0x' + word.slice(-40), label);
}

function safeStorageIdentity(policy, label) {
  return {
    singleton: addressFromStorageWord(policy && policy.singletonStorage, (label || 'Safe') + ' singleton'),
    fallbackHandler: addressFromStorageWord(policy && policy.fallbackHandlerStorage, (label || 'Safe') + ' fallback handler'),
  };
}

// Bind the service-supplied creation calldata to live source-chain proxy storage. A changed singleton or fallback
// handler means replaying the old creation would produce a different authority even when owners still happen to
// match, so reject before asking the wallet to send anything.
export function verifySafeCreationIdentity(initializer, creationSingleton, sourcePolicy) {
  var setup = verifyDecodedSafeSetup(decodeSafeSetupInitializer(initializer), sourcePolicy);
  var sourceIdentity = safeStorageIdentity(sourcePolicy, 'The source Safe');
  if (normalizedAddress(creationSingleton, 'The creation singleton') !== sourceIdentity.singleton) {
    throw new Error('The Safe’s current singleton differs from its creation record. Deployment was stopped.');
  }
  if (normalizedAddress(setup.fallbackHandler, 'The setup fallback handler') !== sourceIdentity.fallbackHandler) {
    throw new Error('The Safe’s current fallback handler differs from its creation initializer. Deployment was stopped.');
  }
  return sourceIdentity;
}

// Guards and modules can change who controls a Safe independently of its owner list. Same-address deployment is
// supported only for plain Safes whose authority is completely described by owners + threshold.
export function verifyPlainSafeDeploymentPolicy(policy, label) {
  var which = label || 'Safe';
  if (!policy || typeof policy.guardStorage !== 'string'
      || !/^0x[0-9a-f]{64}$/i.test(policy.guardStorage)
      || BigInt(policy.guardStorage) !== 0n) {
    throw new Error(which + ' has a transaction guard, so automatic same-address deployment is unsafe.');
  }
  var modulePage = policy.modulePage;
  var modules = modulePage && modulePage[0];
  var next = modulePage && modulePage[1];
  var nextIsSentinel = false;
  try { nextIsSentinel = checksumAddress(next).toLowerCase() === SAFE_MODULES_SENTINEL; } catch (_) {}
  if (!Array.isArray(modules) || modules.length || !nextIsSentinel) {
    throw new Error(which + ' has enabled modules, so automatic same-address deployment is unsafe.');
  }
  return true;
}

// Authenticate the proxy and every component which can affect execution before treating owner/threshold reads as
// Safe governance. This prevents an arbitrary contract from spoofing the Safe view methods and storage layout.
export function verifyRecognizedSafeDeploymentPolicy(policy, label) {
  var which = label || 'Safe';
  verifyPlainSafeDeploymentPolicy(policy, which);
  var governance = normalizedSafeGovernance(policy, which);
  var identity = safeStorageIdentity(policy, which);
  var release = safeReleaseForSingleton(identity.singleton);
  if (!release) throw new Error(which + ' does not use a recognized official Safe singleton.');
  if (normalizedAddress(policy.masterCopy, which + ' masterCopy') !== identity.singleton) {
    throw new Error(which + ' masterCopy does not match singleton slot zero.');
  }
  if (policy.version !== release.version) throw new Error(which + ' VERSION does not match its official singleton.');
  var proxyCode = normalizedRuntimeCode(policy.proxyCode, true, which + ' proxy');
  var proxyCodeHash = keccak256(proxyCode);
  if (!RECOGNIZED_SAFE_PROXY_CODE_HASHES[proxyCodeHash]) {
    throw new Error(which + ' does not use recognized official SafeProxy runtime bytecode.');
  }
  var singletonCode = normalizedRuntimeCode(policy.singletonCode, true, which + ' singleton');
  var ownerCodes = policy.ownerCodes;
  if (!Array.isArray(ownerCodes) || ownerCodes.length !== governance.owners.length) {
    throw new Error('Could not verify every ' + which.toLowerCase() + ' owner as an EOA.');
  }
  ownerCodes.forEach(function (code) {
    var ownerCode = normalizedRuntimeCode(code, false, which + ' owner');
    if (ownerCode && !isEip7702DelegatedEoaRuntime(ownerCode)) {
      throw new Error(which + ' has a contract owner; automatic same-address deployment supports EOA owners only.');
    }
  });
  var fallbackHandlerCode = null;
  if (identity.fallbackHandler === ZERO.toLowerCase()) {
    if (policy.fallbackHandlerCode != null && policy.fallbackHandlerCode !== '0x') {
      throw new Error(which + ' returned bytecode for a zero fallback handler.');
    }
  } else {
    fallbackHandlerCode = normalizedRuntimeCode(policy.fallbackHandlerCode, true, which + ' fallback handler');
    // Unlike an owner key, a fallback handler contributes executable Safe behavior. The 7702 marker alone does
    // not bind the delegated implementation runtime across chains, so automatic replay must fail closed here.
    if (isEip7702DelegatedEoaRuntime(fallbackHandlerCode)) {
      throw new Error(which + ' uses an EIP-7702 delegated fallback handler; automatic same-address deployment is unsupported.');
    }
  }
  return {
    owners: governance.owners, threshold: governance.threshold, proxyCode: proxyCode, proxyCodeHash: proxyCodeHash,
    singleton: identity.singleton, singletonCode: singletonCode, version: release.version,
    fallbackHandler: identity.fallbackHandler, fallbackHandlerCode: fallbackHandlerCode,
  };
}

function sameRecognizedSafeDeploymentPolicy(a, b) {
  var aa = verifyRecognizedSafeDeploymentPolicy(a, 'The source Safe');
  var bb = verifyRecognizedSafeDeploymentPolicy(b, 'The deployed Safe');
  return aa.threshold === bb.threshold && aa.owners.length === bb.owners.length
    && aa.owners.every(function (owner, i) { return owner === bb.owners[i]; })
    && aa.proxyCode === bb.proxyCode && aa.singleton === bb.singleton && aa.singletonCode === bb.singletonCode
    && aa.version === bb.version && aa.fallbackHandler === bb.fallbackHandler
    && aa.fallbackHandlerCode === bb.fallbackHandlerCode;
}

async function readSafeDeploymentPolicy(chainId, safe) {
  var pub = createPublicClientForChain(chainId);
  var safeAddress = cs(safe);
  // Authenticate the immutable proxy shape and slot-zero singleton before invoking any delegated Safe view.
  // The delegated calls below are independently gas/return-data bounded, but this ordering also prevents an
  // arbitrary singleton from being treated as a candidate governance implementation.
  var preflight = await Promise.all([
    pub.getBytecode({ address: safeAddress }),
    pub.getStorageAt({ address: safeAddress, slot: SAFE_SINGLETON_STORAGE_SLOT }),
  ]);
  var proxyCode = normalizedRuntimeCode(preflight[0], true, 'Safe proxy');
  if (!RECOGNIZED_SAFE_PROXY_CODE_HASHES[keccak256(proxyCode)]) {
    throw new Error('Safe does not use recognized official SafeProxy runtime bytecode.');
  }
  var singleton = addressFromStorageWord(preflight[1], 'Safe singleton');
  if (!safeReleaseForSingleton(singleton)) throw new Error('Safe does not use a recognized official Safe singleton.');
  var singletonCode = normalizedRuntimeCode(await pub.getBytecode({ address: cs(singleton) }), true, 'Safe singleton');
  var masterCopy = await readSafeMasterCopyBounded(pub, safeAddress);
  if (normalizedAddress(masterCopy, 'Safe masterCopy') !== singleton) {
    throw new Error('Safe masterCopy does not match singleton slot zero.');
  }
  var values = await Promise.all([
    readSafeUintBounded(pub, safeAddress, 'getThreshold'),
    readSafeOwnersBounded(pub, safeAddress),
    readSafeModulesBounded(pub, safeAddress),
    pub.getStorageAt({ address: safeAddress, slot: SAFE_GUARD_STORAGE_SLOT }),
    pub.getStorageAt({ address: safeAddress, slot: SAFE_FALLBACK_HANDLER_STORAGE_SLOT }),
    readSafeVersionBounded(pub, safeAddress),
  ]);
  var policy = {
    threshold: Number(values[0]), owners: values[1] || [], modulePage: values[2], guardStorage: values[3],
    singletonStorage: preflight[1], fallbackHandlerStorage: values[4], proxyCode: proxyCode,
    masterCopy: masterCopy, version: values[5], singletonCode: singletonCode,
  };
  var storageIdentity = safeStorageIdentity(policy, 'Safe');
  var owners = normalizedSafeGovernance(policy, 'Safe').owners;
  var relatedAddresses = owners.slice();
  if (storageIdentity.fallbackHandler !== ZERO.toLowerCase()) relatedAddresses.push(storageIdentity.fallbackHandler);
  var relatedCode = await Promise.all(relatedAddresses.map(function (address) { return pub.getBytecode({ address: address }); }));
  policy.ownerCodes = relatedCode.slice(0, owners.length);
  policy.fallbackHandlerCode = storageIdentity.fallbackHandler === ZERO.toLowerCase() ? null : relatedCode[relatedCode.length - 1];
  return policy;
}

async function verifySafeDeploymentDestination(client, creation, expectedSafe, sourcePolicy) {
  var source = verifyRecognizedSafeDeploymentPolicy(sourcePolicy, 'The source Safe');
  var addresses = [expectedSafe, creation.factory, creation.singleton].concat(source.owners);
  if (source.fallbackHandler !== ZERO.toLowerCase()) addresses.push(source.fallbackHandler);
  var codes = await Promise.all(addresses.map(function (address) { return client.getBytecode({ address: cs(address) }); }));
  if (normalizedRuntimeCode(codes[0], false, 'The target Safe address')) {
    throw new Error('The expected Safe address is already occupied on the target chain.');
  }
  normalizedRuntimeCode(codes[1], true, 'The official Safe proxy factory');
  var targetSingletonCode = normalizedRuntimeCode(codes[2], true, 'The target Safe singleton');
  if (targetSingletonCode !== source.singletonCode) throw new Error('The target Safe singleton bytecode does not match the source chain.');
  codes.slice(3, 3 + source.owners.length).forEach(function (code) {
    var ownerCode = normalizedRuntimeCode(code, false, 'A target Safe owner');
    if (ownerCode && !isEip7702DelegatedEoaRuntime(ownerCode)) {
      throw new Error('A Safe owner is a contract on the target chain; automatic same-address deployment was stopped.');
    }
  });
  if (source.fallbackHandler !== ZERO.toLowerCase()) {
    var targetFallbackCode = normalizedRuntimeCode(codes[codes.length - 1], true, 'The target Safe fallback handler');
    if (isEip7702DelegatedEoaRuntime(targetFallbackCode)) {
      throw new Error('The target Safe uses an EIP-7702 delegated fallback handler; automatic same-address deployment was stopped.');
    }
    if (targetFallbackCode !== source.fallbackHandlerCode) throw new Error('The target Safe fallback handler bytecode does not match the source chain.');
  }
  return true;
}

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
      if (j && typeof j.factoryAddress === 'string' && typeof j.masterCopy === 'string'
          && typeof j.setupData === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(j.setupData)) {
        var saltText = typeof j.saltNonce === 'string' ? j.saltNonce
          : (Number.isSafeInteger(j.saltNonce) && j.saltNonce >= 0 ? String(j.saltNonce) : '');
        if (!/^\d+$/.test(saltText) || !isRecognizedSafeFactoryPair(j.factoryAddress, j.masterCopy)) continue;
        return {
          factory: checksumAddress(j.factoryAddress), singleton: checksumAddress(j.masterCopy), initializer: j.setupData,
          saltNonce: BigInt(saltText), sourceChainId: Number(candidates[i]),
        };
      }
    } catch (_) {}
  }
  return null;
}

// Deploy the same-address Safe on `chainId` from a fetched creation record, then verify it actually landed at the
// expected address (a differing factory/singleton on the target chain would produce a different address).
export async function deploySafeSameAddress(chainId, creation, expectedSafe, authoritySourceChainId) {
  var sourceChainId = authoritySourceChainId != null ? Number(authoritySourceChainId) : Number(creation && creation.sourceChainId);
  if (!Number.isSafeInteger(sourceChainId) || sourceChainId <= 0) throw new Error('The Safe creation record is missing its source chain. Read it again before deploying.');
  if (!creation || typeof creation.saltNonce !== 'bigint' || creation.saltNonce < 0n) throw new Error('The Safe creation record has an invalid salt nonce.');
  if (!isRecognizedSafeFactoryPair(creation.factory, creation.singleton)) {
    throw new Error('The Safe creation record does not use a recognized official factory and singleton pair.');
  }
  var sourceGovernance;
  try { sourceGovernance = await readSafeDeploymentPolicy(sourceChainId, expectedSafe); }
  catch (error) { throw new Error((error && error.message) || 'Could not verify the Safe’s current governance and identity on its source chain. Deployment was stopped.'); }
  verifyRecognizedSafeDeploymentPolicy(sourceGovernance, 'The source Safe');
  verifySafeCreationIdentity(creation.initializer, creation.singleton, sourceGovernance);
  var targetPublicClient = createPublicClientForChain(Number(chainId));
  try { await verifySafeDeploymentDestination(targetPublicClient, creation, expectedSafe, sourceGovernance); }
  catch (error) { throw new Error((error && error.message) || 'Could not verify the Safe deployment contracts on the target chain.'); }
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to deploy.'); }
  var hash = await sendAndConfirm(wallet, chainId, { address: cs(creation.factory), abi: PROXY_FACTORY_ABI, functionName: 'createProxyWithNonce', args: [cs(creation.singleton), creation.initializer, creation.saltNonce] }, 'createProxyWithNonce', expectedSafe);
  // Verify the Safe landed at the expected address — but RETRY, because a flaky RPC (Base/OP Sepolia especially) can
  // return empty code for a just-deployed contract and produce a false "did not land". Only fail after several misses.
  var pub = targetPublicClient, code = null;
  for (var attempt = 0; attempt < 6; attempt++) {
    code = await pub.getBytecode({ address: cs(expectedSafe) }).catch(function () { return null; });
    if (code && code !== '0x') break;
    await new Promise(function (r) { setTimeout(r, 1500); });
  }
  if (!code || code === '0x') throw new Error('Deployed, but the Safe isn’t readable at ' + expectedSafe + ' yet — the RPC may be lagging. Reload to check; if it stays missing, the factory/singleton on this chain differ from the original.');
  var postDeploymentPolicies = null, postDeploymentError = null;
  for (var governanceAttempt = 0; governanceAttempt < 4; governanceAttempt++) {
    try {
      postDeploymentPolicies = await Promise.all([
        readSafeDeploymentPolicy(sourceChainId, expectedSafe),
        readSafeDeploymentPolicy(Number(chainId), expectedSafe),
      ]);
      break;
    }
    catch (error) { postDeploymentError = error; if (governanceAttempt < 3) await new Promise(function (r) { setTimeout(r, 1000); }); }
  }
  if (!postDeploymentPolicies) throw new Error((postDeploymentError && postDeploymentError.message)
    || 'Deployed, but the source/target Safe governance and identity are not readable yet. Reload and verify its policy before using it.');
  if (!sameRecognizedSafeDeploymentPolicy(postDeploymentPolicies[0], postDeploymentPolicies[1])) {
    throw new Error('The deployed Safe’s recognized proxy, implementation, handler, owners, or threshold do not match the source Safe. Do not use it on this chain.');
  }
  return hash;
}

// The SafeTx hash for a {to, data, value, nonce} call — what signers approve and what execTransaction must match.
export function safeTxHashForCall(chainId, safe, call) {
  return safeTxHashOf(chainId, safe, {
    to: call.to, value: call.value || 0, data: call.data || '0x', operation: 0,
    safeTxGas: 0, baseGas: 0, gasPrice: 0, gasToken: ZERO, refundReceiver: ZERO, nonce: call.nonce,
  });
}

// Recompute the canonical EIP-712 hash for a complete queued service record. Transaction-service hashes are
// untrusted metadata until this matches every execution field the user reviewed.
export function safeTxHashForQueuedTx(chainId, safe, tx) {
  return safeTxHashOf(chainId, safe, {
    to: tx.to, value: tx.value || 0, data: tx.data || '0x', operation: Number(tx.operation || 0),
    safeTxGas: tx.safeTxGas || 0, baseGas: tx.baseGas || 0, gasPrice: tx.gasPrice || 0,
    gasToken: tx.gasToken || ZERO, refundReceiver: tx.refundReceiver || ZERO, nonce: tx.nonce,
  });
}

// Read the Safe's onchain params (nonce / threshold / owners) directly — no Transaction Service.
export async function safeOnChainContext(chainId, safe) {
  var pub = createPublicClientForChain(chainId);
  var r = await Promise.all([
    readSafeUintBounded(pub, safe, 'nonce'),
    readSafeUintBounded(pub, safe, 'getThreshold'),
    readSafeOwnersBounded(pub, safe),
  ]);
  var nonce = BigInt(r[0]), threshold = BigInt(r[1]), owners = r[2] || [];
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER) || threshold < 1n || threshold > BigInt(owners.length)) {
    throw new Error('The Safe returned invalid nonce or threshold state.');
  }
  return { nonce: Number(nonce), threshold: Number(threshold), owners: owners };
}

// Which of `owners` have approved `hash` onchain (approvedHashes == 1). Returns the approved owner addresses.
export async function safeApprovalsOf(chainId, safe, hash, owners) {
  var pub = createPublicClientForChain(chainId);
  if (!Array.isArray(owners) || owners.length > SAFE_MAX_OWNERS) throw new Error('The Safe owner list is too large to read approvals safely.');
  var flags = await Promise.all(owners.map(function (o) {
    return readSafeUintBounded(pub, safe, 'approvedHashes', [o, hash])
      .then(function (v) { return BigInt(v) > 0n; });
  }));
  return owners.filter(function (o, i) { return flags[i]; });
}

// Approve a SafeTx hash onchain from the connected signer (records approvedHashes[signer][hash] = 1). The wallet
// must be on `chainId` and be a Safe owner. Returns the approveHash tx hash.
export async function approveSafeHashOnChain(chainId, safe, hash, reverify) {
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) { await switchChain(Number(chainId)); wallet = getWalletClient(); }
  } catch (e) { if (e && e.code === 4001) throw e; throw new Error('Switch your wallet to ' + ((CHAINS[chainId] && CHAINS[chainId].name) || chainId) + ' to approve.'); }
  return sendAndConfirm(wallet, chainId, { address: cs(safe), abi: SAFE_ONCHAIN_ABI, functionName: 'approveHash', args: [hash] }, 'approveHash', null, reverify);
}

export { SAFE_PREFIX };
