// src/relayr.js
// Cross-chain transaction submission via relayr (the permissionless Bananapus relay), modelled on the
// revnet-app / juice-sdk-v4 flow. Each per-chain call is wrapped as an ERC-2771 meta-transaction:
// the operator signs an OpenZeppelin ForwardRequest, we encode `ERC2771Forwarder.execute(req)`, and
// relayr executes that on every chain after a single prepaid payment.
//
// Flow:
//   1. buildForwardedTx(chainId, from, to, data)  -> signs ForwardRequest, returns {chain, target, data, value}
//   2. relayrPostBundle(transactions)             -> POST /v1/bundle/prepaid -> { bundle_uuid, payment_info }
//   3. relayrPay(payment)                         -> one onchain payment funds all chains
//   4. relayrPoll(uuid, onUpdate)                 -> GET /v1/bundle/{uuid} until every tx is complete
//
// No API key. Host confirmed from juice-sdk-v4: https://api.relayr.ba5ed.com

import { encodeFunctionData, isAddress } from 'viem';
import { getWalletClient, getAccount, createPublicClientForChain, getAddress, switchChain, getViewAs, VIEW_AS_TX_ERROR } from './component-base.js';
import { CHAINS } from './chain.js';

var RELAYR_API = 'https://api.relayr.ba5ed.com';
var RELAYR_PENDING_PREFIX = 'jb-relayr-pending-v1:';
var RELAYR_QUOTE_TIMEOUT_MS = 45 * 1000;
var RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15 * 1000;
// Consecutive 404s that prove the uuid was never Relayr's rather than a single blip from the gateway.
var RELAYR_NOT_FOUND_ATTEMPTS = 3;

// A backend fetch can stall without ever rejecting, which used to leave the UI frozen forever. Bound each
// HTTP attempt; status polling will retry the same bundle, while quote requests fail before any payment.
function relayrFetch(url, options, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var requestOptions = Object.assign({}, options || {});
    if (controller) requestOptions.signal = controller.signal;
    var timer = setTimeout(function () {
      if (controller) controller.abort();
      var error = new Error('Relayr request timed out.');
      error.code = 'RELAYR_HTTP_TIMEOUT';
      reject(error);
    }, Math.max(1, Number(timeoutMs) || RELAYR_STATUS_REQUEST_TIMEOUT_MS));
    fetch(url, requestOptions).then(function (value) {
      clearTimeout(timer); resolve(value);
    }, function (error) {
      clearTimeout(timer); reject(error);
    });
  });
}

// Minimal OpenZeppelin ERC2771Forwarder surface.
var FORWARDER_ABI = [
  { type: 'function', name: 'nonces', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'eip712Domain', stateMutability: 'view', inputs: [], outputs: [
    { name: 'fields', type: 'bytes1' }, { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    { name: 'salt', type: 'bytes32' }, { name: 'extensions', type: 'uint256[]' } ] },
  { type: 'function', name: 'execute', stateMutability: 'payable', outputs: [], inputs: [
    { name: 'request', type: 'tuple', components: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'gas', type: 'uint256' }, { name: 'deadline', type: 'uint48' },
      { name: 'data', type: 'bytes' }, { name: 'signature', type: 'bytes' } ] }] },
];

// Sign an ERC-2771 ForwardRequest for `to`/`data` on `chainId` and return the relayr transaction entry.
// The EIP-712 domain (name/version) is read from the forwarder at runtime (EIP-5267) so we never guess it.
// `value` is the ETH forwarded to the target (e.g. a project-creation fee); the relayer sends it with
// `execute`, so it appears as the bundle tx's `value` and Relayr's quote covers it.
export async function buildForwardedTx(chainId, from, to, data, gasHint, value) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var forwarder = getAddress('ERC2771Forwarder', chainId);
  if (!forwarder) throw new Error('No ERC2771Forwarder on ' + (CHAINS[chainId] && CHAINS[chainId].name || chainId));
  var pub = createPublicClientForChain(chainId);
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  var val = value || 0n;

  // MetaMask (and especially a Ledger via MetaMask) reject eth_signTypedData_v4 when the EIP-712 domain's
  // chainId differs from the wallet's ACTIVE chain ("Provided chainId X must match the active chainId Y").
  // Each forward request is domain-bound to its target chain, so switch the wallet there before signing.
  try {
    var active = await wallet.getChainId();
    if (active !== Number(chainId)) {
      await switchChain(Number(chainId));
      wallet = getWalletClient(); // switchChain recreates the client on the new chain
    }
  } catch (e) {
    throw new Error('Switch your wallet to ' + (CHAINS[chainId] && CHAINS[chainId].name || chainId) + ' to sign its request (' + ((e && e.message) || e) + ')');
  }
  if (!getAccount() || getAccount().toLowerCase() !== from.toLowerCase()) throw new Error('Connected account changed. Review the cross-chain request again.');

  var domTuple = await pub.readContract({ address: forwarder, abi: FORWARDER_ABI, functionName: 'eip712Domain', args: [] });
  var domainName = domTuple[1], domainVersion = domTuple[2];
  var nonce = await pub.readContract({ address: forwarder, abi: FORWARDER_ABI, functionName: 'nonces', args: [from] });

  var deadline = Math.floor(Date.now() / 1000) + 47 * 3600; // uint48 seconds (< 48h Relayr max)
  // Measure the destination call rather than signing a flat guess. The forwarder caps the
  // inner call at `gas` and reverts `execute` if it runs out, so an undersized constant
  // burns a bundle the user has already paid for; an oversized one inflates every quote.
  // The caller's hint wins when given, and the constant remains the fallback.
  var gas = gasHint;
  if (!gas) {
    try {
      var estimated = await pub.estimateGas({ account: forwarder, to: to, data: data, value: val });
      gas = (estimated * 3n) / 2n;
    } catch (_) {
      gas = 500000n; // estimation unavailable — Relayr still simulates server-side and refuses a bad quote
    }
  }

  var signature = await wallet.signTypedData({
    account: from,
    domain: { name: domainName, version: domainVersion, chainId: BigInt(chainId), verifyingContract: forwarder },
    types: { ForwardRequest: [
      { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
      { name: 'gas', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint48' }, { name: 'data', type: 'bytes' } ] },
    primaryType: 'ForwardRequest',
    message: { from: from, to: to, value: val, gas: gas, nonce: nonce, deadline: deadline, data: data },
  });
  if (!getAccount() || getAccount().toLowerCase() !== from.toLowerCase()) throw new Error('Connected account changed. Review the cross-chain request again.');

  var requestData = { from: from, to: to, value: val, gas: gas, deadline: deadline, data: data, signature: signature };
  var execData = encodeFunctionData({ abi: FORWARDER_ABI, functionName: 'execute', args: [requestData] });
  return { chain: Number(chainId), target: forwarder, data: execData, value: val.toString() };
}

// POST the bundle and return { bundle_uuid, payment_info:[{chain,amount,calldata,target,token,payment_deadline}], ... }.
export async function relayrPostBundle(transactions) {
  // Order each chain's transactions by their position in the array (per-chain 0,1,2… virtual nonces) and run in
  // ChainIndependent mode: chains execute in parallel, but a single chain's txs run STRICTLY in that order — each
  // after the previous confirms, against the updated state. This lets a bundle carry sequential same-chain txs
  // (e.g. Safe execTransactions at consecutive nonces) without Relayr quoting every one against the current state
  // (which reverts future-nonce txs — the "Disabled"-mode SimulationReverted). Cross-chain one-per-chain bundles
  // are unchanged (every tx gets virtual nonce 0). Callers must build the array in intended per-chain order.
  var perChain = {};
  var ordered = transactions.map(function (t) {
    var vn = perChain[t.chain] || 0; perChain[t.chain] = vn + 1;
    return Object.assign({}, t, { virtual_nonce: vn });
  });
  var res;
  try {
    res = await relayrFetch(RELAYR_API + '/v1/bundle/prepaid', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: ordered, virtual_nonce_mode: 'ChainIndependent' }),
    }, RELAYR_QUOTE_TIMEOUT_MS);
  } catch (error) {
    if (error && error.code === 'RELAYR_HTTP_TIMEOUT') {
      var timeout = new Error('Relayr did not return a quote in time. Nothing was paid; it is safe to try again.');
      timeout.code = 'RELAYR_QUOTE_TIMEOUT'; timeout.retryable = true;
      throw timeout;
    }
    throw error;
  }
  if (!res.ok) {
    var detail = ''; try { detail = await res.text(); } catch (_) {}
    throw new Error('Relayr HTTP ' + res.status + (detail ? ': ' + detail.slice(0, 240) : ''));
  }
  var body = await res.json();
  if (!body || !body.bundle_uuid) throw new Error('Relayr returned no bundle ID. Nothing was paid.');
  return body;
}

// Send the single prepaid payment that funds execution on every chain. Caller ensures the wallet is on
// payment.chain. Returns the payment tx hash.
export async function relayrPay(payment, expectedAccount) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var chainId = Number(payment && payment.chain);
  if (!Number.isSafeInteger(chainId) || !CHAINS[chainId]) throw new Error('Relayr returned an unsupported payment chain.');
  if (!payment || !isAddress(payment.target, { strict: false })) throw new Error('Relayr returned an invalid payment target.');
  var amount; try { amount = BigInt(payment.amount); } catch (_) { throw new Error('Relayr returned an invalid payment amount.'); }
  if (amount < 0n) throw new Error('Relayr returned an invalid payment amount.');
  var calldata = payment.calldata || '0x';
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)) throw new Error('Relayr returned invalid payment calldata.');
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  var account = getAccount();
  if (!account) throw new Error('Connect a wallet first');
  if (expectedAccount && account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var active = await wallet.getChainId().catch(function () { return null; });
  if (active !== chainId) { await switchChain(chainId); wallet = getWalletClient(); }
  if (!wallet || !getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var pub = createPublicClientForChain(chainId);
  await pub.estimateGas({ account: account, to: payment.target, value: amount, data: calldata });
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var hash = await wallet.sendTransaction({
    account: account,
    chain: CHAINS[chainId],
    to: payment.target,
    value: amount,
    data: calldata,
  });
  var receipt = await pub.waitForTransactionReceipt({ hash: hash });
  if (receipt && receipt.status && receipt.status !== 'success') throw new Error('Relayr payment reverted onchain.');
  return hash;
}

// Relayr has returned both Success and Completed for terminal successful records. Keep that protocol
// detail in one place so progress counters cannot sit at 0/N after the destination already confirmed.
export function relayrStateIsSuccess(state) {
  state = String(state || '').toLowerCase();
  return state === 'success' || state === 'completed';
}

export function relayrStateIsFailed(state) {
  return String(state || '').toLowerCase() === 'failed';
}

export function relayrProgress(records, expectedCount) {
  records = Array.isArray(records) ? records : [];
  var confirmed = records.filter(function (t) { return relayrStateIsSuccess(t && t.status && t.status.state); }).length;
  var failed = records.filter(function (t) { return relayrStateIsFailed(t && t.status && t.status.state); }).length;
  var expected = Number(expectedCount);
  var total = Number.isSafeInteger(expected) && expected > 0 ? Math.max(expected, records.length) : records.length;
  return {
    confirmed: confirmed, failed: failed, pending: Math.max(0, total - confirmed - failed), total: total,
    // The rule that decides whether a paid receipt may be auto-discarded; keep it in one place.
    allFailed: total > 0 && confirmed === 0 && failed >= total,
  };
}

function relayrExecutionError(message, code, uuid, records, retryable) {
  var error = new Error(message);
  error.name = 'RelayrExecutionError';
  error.code = code;
  error.bundleUuid = uuid;
  error.records = Array.isArray(records) ? records : [];
  error.retryable = !!retryable;
  return error;
}

export function relayrErrorIsUncertain(error) {
  return !!(error && error.code === 'RELAYR_TIMEOUT');
}

// Persist only the small, non-sensitive receipt needed to resume status checks. In particular, never put
// signed forward requests or calldata in localStorage. `scope` is supplied by the feature (for example a
// project-specific "add shop items" key).
//
// Receipts are device-local AND wallet-local: the storage key carries the connected account, so a second
// wallet on the same browser never sees (or resumes) the first wallet's bundles. With no wallet connected
// there is nothing to key by, so storage falls back to the unkeyed (legacy) key; the first wallet that
// reads such an entry adopts it into its own namespace (best-effort migration).
function relayrAccountPart() {
  try { var account = getAccount && getAccount(); return account ? String(account).toLowerCase() + ':' : ''; } catch (_) { return ''; }
}
// Feature scopes never start with a bare address ('create-project', 'action:…', 'bundle:…', 'shop-…'),
// so an account prefix is unambiguous in stored keys.
var RELAYR_ACCOUNT_KEYED = /^0x[0-9a-f]{40}:/;
function relayrPendingStorageKey(scope) { return RELAYR_PENDING_PREFIX + relayrAccountPart() + String(scope || ''); }
function relayrLegacyStorageKey(scope) { return RELAYR_PENDING_PREFIX + String(scope || ''); }

// Status polling persists after every tick; skip the synchronous localStorage write when nothing changed.
var RELAYR_LAST_SAVED = {};

function relayrRecordSnapshot(record) {
  return {
    status: {
      state: String(record && record.status && record.status.state || ''),
      data: { hash: relayrDestinationHash(record) || null },
    },
  };
}

export function saveRelayrPendingSession(scope, session) {
  if (!scope || !session || !session.bundleUuid) return null;
  var snapshot = {
    bundleUuid: String(session.bundleUuid),
    paymentHash: session.paymentHash ? String(session.paymentHash) : null,
    paymentChainId: Number(session.paymentChainId) || null,
    expectedCount: Math.max(0, Number(session.expectedCount) || 0),
    chains: (session.chains || []).map(function (chain) {
      return { id: Number(chain.id || chain.cid), name: String(chain.name || '') };
    }).filter(function (chain) { return Number.isSafeInteger(chain.id) && chain.id > 0; }),
    records: (session.records || []).map(relayrRecordSnapshot),
    itemCount: Math.max(0, Number(session.itemCount) || 0),
    paymentState: session.paymentState === 'expired' ? 'expired' : null,
    persisted: true,
  };
  var key = relayrPendingStorageKey(scope);
  var serialized = JSON.stringify(snapshot);
  if (RELAYR_LAST_SAVED[key] === serialized) return snapshot;
  try { localStorage.setItem(key, serialized); RELAYR_LAST_SAVED[key] = serialized; } catch (_) { snapshot.persisted = false; }
  return snapshot;
}

export function loadRelayrPendingSession(scope) {
  if (!scope) return null;
  try {
    var raw = localStorage.getItem(relayrPendingStorageKey(scope));
    // Adopt a pre-account-keyed receipt into the connected wallet's namespace on first read.
    if (!raw && relayrAccountPart()) {
      var legacy = localStorage.getItem(relayrLegacyStorageKey(scope));
      if (legacy) {
        raw = legacy;
        try {
          localStorage.setItem(relayrPendingStorageKey(scope), legacy);
          localStorage.removeItem(relayrLegacyStorageKey(scope));
        } catch (_) {}
      }
    }
    if (!raw) return null;
    var session = JSON.parse(raw);
    if (!session || typeof session.bundleUuid !== 'string' || !session.bundleUuid) throw new Error('Invalid Relayr session');
    session.records = Array.isArray(session.records) ? session.records : [];
    session.chains = Array.isArray(session.chains) ? session.chains : [];
    session.expectedCount = Math.max(0, Number(session.expectedCount) || session.chains.length || 0);
    return session;
  } catch (_) {
    try { localStorage.removeItem(relayrPendingStorageKey(scope)); } catch (_) {}
    return null;
  }
}

// Every scope with a persisted pending session for the CONNECTED wallet (the part of the storage key
// after the shared prefix and account). Lets the account view surface all in-flight Relayr work without
// knowing each feature's scope scheme. Other wallets' receipts are never listed; legacy unkeyed entries
// surface only once a wallet is connected (and are adopted by it on first load). With no wallet there is
// no identity to scope by, so nothing is listed.
export function listRelayrPendingScopes() {
  var scopes = [];
  var accountPart = relayrAccountPart();
  if (!accountPart) return scopes;
  var seen = {};
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key || key.indexOf(RELAYR_PENDING_PREFIX) !== 0) continue;
      var rest = key.slice(RELAYR_PENDING_PREFIX.length);
      var scope = null;
      if (RELAYR_ACCOUNT_KEYED.test(rest)) {
        if (rest.indexOf(accountPart) === 0) scope = rest.slice(accountPart.length);
      } else {
        scope = rest; // legacy unkeyed — adopted on first load
      }
      if (scope && !seen[scope]) { seen[scope] = true; scopes.push(scope); }
    }
  } catch (_) {}
  return scopes;
}

export function clearRelayrPendingSession(scope) {
  // Remove the connected wallet's copy AND any legacy unkeyed copy, so a cleared receipt can't be
  // re-adopted from the pre-migration key later.
  [relayrPendingStorageKey(scope), relayrLegacyStorageKey(scope)].forEach(function (key) {
    delete RELAYR_LAST_SAVED[key];
    try { localStorage.removeItem(key); } catch (_) {}
  });
}

// Poll GET /v1/bundle/{uuid} every `intervalMs` until every transaction reports Success/Completed.
// Calls onUpdate(transactions[]) each tick. Resolves with the final transactions; rejects with a structured
// RelayrExecutionError on a terminal Failed record or timeout. A timeout means outcome unknown, not failed.
// Each transaction's destination hash lives at status.data.hash or status.data.transaction.hash.
export function relayrPoll(uuid, onUpdate, intervalMs, timeoutMs) {
  intervalMs = intervalMs || 2500;
  timeoutMs = timeoutMs || 5 * 60 * 1000;
  var start = Date.now();
  var lastRecords = [];
  return new Promise(function (resolve, reject) {
    // Sentinel body meaning "Relayr keeps saying it has never heard of this uuid" — distinct from any real payload.
    var NOT_FOUND = {};
    var notFoundStreak = 0;
    function timedOut() { return Date.now() - start >= timeoutMs; }
    function timeout() {
      return relayrExecutionError('Relayr is still processing paid bundle ' + uuid + '. Do not submit this action again; check the original bundle later.', 'RELAYR_TIMEOUT', uuid, lastRecords, true);
    }
    function tick() {
      var remaining = Math.max(1, timeoutMs - (Date.now() - start));
      relayrFetch(RELAYR_API + '/v1/bundle/' + uuid, null, Math.min(RELAYR_STATUS_REQUEST_TIMEOUT_MS, remaining)).then(function (r) {
        // A 404 is not a transient status error: Relayr has no such bundle. Retrying it to the full window and
        // then reporting RELAYR_TIMEOUT tells the user to keep waiting on something that will never land. Tolerate
        // a short blip from the gateway; only an unbroken run of 404s is terminal, and it is NOT retryable.
        if (r.status === 404) {
          notFoundStreak++;
          if (notFoundStreak >= RELAYR_NOT_FOUND_ATTEMPTS) return NOT_FOUND;
          throw new Error('Relayr status HTTP 404');
        }
        notFoundStreak = 0;
        if (!r.ok) throw new Error('Relayr status HTTP ' + r.status);
        return r.json();
      }).then(function (body) {
        if (body === NOT_FOUND) return reject(relayrExecutionError(
          'Relayr does not recognize bundle ' + uuid + '. Nothing is pending under it and nothing more will land. If you already paid, keep the payment hash and bundle ID for support before starting over.',
          'RELAYR_NOT_FOUND', uuid, lastRecords, false
        ));
        var txs = (body && body.transactions) || [];
        lastRecords = txs;
        if (onUpdate) onUpdate(txs, body);
        if (txs.length && txs.every(function (t) { return relayrStateIsSuccess(t && t.status && t.status.state); })) return resolve(txs);
        var failed = txs.filter(function (t) { return relayrStateIsFailed(t && t.status && t.status.state); });
        if (failed.length) return reject(relayrExecutionError(
          'Relayr bundle ' + uuid + ' failed on ' + failed.length + ' chain' + (failed.length > 1 ? 's' : '') + '. Nothing was resubmitted; check confirmed chains before trying again.',
          'RELAYR_FAILED', uuid, txs, false
        ));
        // A wallet receipt only proves that the payment-contract call mined.
        // Relayr separately reports whether it attributed that payment to this
        // bundle. Once an unrecognized quote expires, "Pending" is terminal:
        // continuing to poll forever hides the actual recovery path.
        var expiresAt = body && body.expires_at ? Date.parse(body.expires_at) : NaN;
        if (body && body.payment_received === false && Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
          return reject(relayrExecutionError(
            'Relayr did not recognize the confirmed payment before bundle ' + uuid + ' expired. Nothing deployed. Keep the payment hash and bundle ID for support; do not treat this as a still-pending deployment.',
            'RELAYR_PAYMENT_EXPIRED', uuid, txs, false
          ));
        }
        if (timedOut()) return reject(timeout());
        setTimeout(tick, intervalMs);
      }).catch(function () {
        if (timedOut()) return reject(timeout());
        setTimeout(tick, intervalMs);
      });
    }
    tick();
  });
}

// Pull the destination tx hash off a polled transaction record, whatever its state shape.
export function relayrDestinationHash(record) {
  var data = record && record.status && record.status.data;
  return (data && (data.hash || (data.transaction && data.transaction.hash))) || null;
}
