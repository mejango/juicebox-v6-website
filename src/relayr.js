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

import { encodeFunctionData, isAddress, keccak256, stringToHex } from 'viem';
import { getWalletClient, getAccount, createPublicClientForChain, getAddress, switchChain, getViewAs, VIEW_AS_TX_ERROR, waitForTrackedTransactionReceipt, confirmTransactionModal } from './component-base.js';
import { CHAINS } from './chain.js';
import { gasWithHeadroom } from './gas.js';
import { decodeSafeExecRelayrTx, hasExactSafeExecutionSuccess, readSafeUintBounded } from './safe.js';

var RELAYR_API = 'https://api.relayr.ba5ed.com';
var RELAYR_PENDING_PREFIX = 'jb-relayr-pending-v1:';
var RELAYR_QUOTE_TIMEOUT_MS = 45 * 1000;
var RELAYR_STATUS_REQUEST_TIMEOUT_MS = 15 * 1000;
// Consecutive 404s that prove the uuid was never Relayr's rather than a single blip from the gateway.
var RELAYR_NOT_FOUND_ATTEMPTS = 3;
var RELAYR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Relayr's prepaid-native payment endpoint is deliberately pinned client-side. A quote is an untrusted HTTP
// response: accepting an arbitrary `target` + `calldata` here would turn a compromised API into a wallet
// transaction oracle (for example, an ERC-20 approve disguised as "Pay & execute"). The same immutable runtime
// is deployed at this address on Relayr's four supported payment chains. Its sole entry point receives the
// quote's bytes16 bundle UUID and uint40 deadline, forwards msg.value to Relayr's fixed receiver, and emits the
// payment event. Keep the code hash, address, selector, and exact two-word calldata schema frozen together.
export var RELAYR_PAYMENT_ADDRESS = '0x1c05f7841379d4393574c0ffa17908ec40ffd97d';
export var RELAYR_PAYMENT_SELECTOR = '0x103903a7';
export var RELAYR_PAYMENT_CODE_HASH = '0x6006b5acadb4cd60aa5c00cb844c34563e182dff83d4f4ff4fde226f7df16fa6';
export var RELAYR_NATIVE_TOKEN = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
var RELAYR_PAYMENT_CHAINS = new Set([1, 10, 8453, 42161]);
var RELAYR_PAYMENT_GAS = 150000n;
var RELAYR_PAYMENT_CODE_MAX_BYTES = 2048;

function relayrDeadlineSeconds(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    var numeric = Number(value);
    if (Number.isSafeInteger(numeric) && numeric >= 0) return numeric;
  }
  var milliseconds = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return Math.floor(milliseconds / 1000);
}

// Decode and authenticate the complete payment schema against the quote we just requested. Exported so the
// boundary stays regression-testable without a wallet or DOM.
export function relayrPaymentDetails(payment, expectedBundleUuid, nowSeconds) {
  var chainId = Number(payment && payment.chain);
  if (!Number.isSafeInteger(chainId) || !RELAYR_PAYMENT_CHAINS.has(chainId) || !CHAINS[chainId]) {
    throw new Error('Relayr returned an unsupported payment chain.');
  }
  if (!payment || !isAddress(payment.target, { strict: false }) || payment.target.toLowerCase() !== RELAYR_PAYMENT_ADDRESS) {
    throw new Error('Relayr returned an unrecognized payment contract.');
  }
  if (String(payment.token || '').toLowerCase() !== RELAYR_NATIVE_TOKEN) {
    throw new Error('Relayr returned an unsupported payment token.');
  }
  var amount;
  try { amount = BigInt(payment.amount); } catch (_) { throw new Error('Relayr returned an invalid payment amount.'); }
  if (amount < 0n) throw new Error('Relayr returned an invalid payment amount.');

  var bundleUuid = String(expectedBundleUuid || '').toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bundleUuid)) {
    throw new Error('Relayr returned an invalid bundle ID.');
  }
  var calldata = String(payment.calldata || '').toLowerCase();
  // 4-byte selector + ABI word(bytes16, right-padded) + ABI word(uint40).
  if (!/^0x[0-9a-f]{136}$/.test(calldata)) throw new Error('Relayr returned invalid payment calldata.');
  if (calldata.slice(0, 10) !== RELAYR_PAYMENT_SELECTOR) throw new Error('Relayr returned an unrecognized payment function.');
  var compactUuid = bundleUuid.replace(/-/g, '');
  if (calldata.slice(10, 74) !== compactUuid + '0'.repeat(32)) {
    throw new Error('Relayr payment calldata does not match this bundle.');
  }
  var deadline;
  try { deadline = BigInt('0x' + calldata.slice(74, 138)); } catch (_) { throw new Error('Relayr returned invalid payment calldata.'); }
  if (deadline > 0xffffffffffn) throw new Error('Relayr returned an invalid payment deadline.');
  var quotedDeadline = relayrDeadlineSeconds(payment.payment_deadline);
  if (quotedDeadline == null || BigInt(quotedDeadline) !== deadline) {
    throw new Error('Relayr payment calldata does not match the quote deadline.');
  }
  var now = Number.isSafeInteger(nowSeconds) ? nowSeconds : Math.floor(Date.now() / 1000);
  if (deadline <= BigInt(now + 15)) throw new Error('This Relayr quote expired. Review the action again for a new quote.');
  return { chainId: chainId, target: RELAYR_PAYMENT_ADDRESS, amount: amount, calldata: calldata, bundleUuid: bundleUuid, deadline: deadline };
}

async function requireRelayrPaymentRuntime(client) {
  var code = await client.request({ method: 'eth_getCode', params: [RELAYR_PAYMENT_ADDRESS, 'latest'] });
  if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || (code.length - 2) / 2 > RELAYR_PAYMENT_CODE_MAX_BYTES) {
    throw new Error('Could not authenticate the Relayr payment contract.');
  }
  if (keccak256(code) !== RELAYR_PAYMENT_CODE_HASH) throw new Error('Relayr payment contract code is not recognized.');
}

async function simulateRelayrPayment(client, account, details) {
  var result = await client.request({
    method: 'eth_call',
    params: [{
      from: account, to: details.target, value: '0x' + details.amount.toString(16), data: details.calldata,
      gas: '0x' + RELAYR_PAYMENT_GAS.toString(16),
    }, 'latest'],
  });
  if (result !== '0x') throw new Error('Relayr payment simulation returned an unexpected result.');
}

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
  // A caller hint is only a floor. Always try a live estimate and raise the
  // signed limit to the larger value so stale constants cannot cap execution.
  var gas = gasHint;
  try {
    var estimated = await pub.estimateGas({ account: forwarder, to: to, data: data, value: val });
    var buffered = gasWithHeadroom(estimated);
    if (!gas || BigInt(gas) < buffered) gas = buffered;
  } catch (_) {
    if (!gas) gas = 500000n; // estimation unavailable — Relayr still simulates server-side and refuses a bad quote
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
  if (!body || !RELAYR_UUID_RE.test(String(body.bundle_uuid || ''))) throw new Error('Relayr returned no valid bundle ID. Nothing was paid.');
  // Relayr deployments have exposed this field as both tx_uuids (current OpenAPI) and txn_uuids (legacy SDK).
  // Accept either exact array, but reject conflicting dual fields rather than guessing which quote mapping won.
  var txUuids = Array.isArray(body.tx_uuids) ? body.tx_uuids : body.txn_uuids;
  if (Array.isArray(body.tx_uuids) && Array.isArray(body.txn_uuids)
      && JSON.stringify(body.tx_uuids) !== JSON.stringify(body.txn_uuids)) txUuids = null;
  if (!Array.isArray(txUuids) || txUuids.length !== ordered.length
      || txUuids.some(function (uuid) { return !RELAYR_UUID_RE.test(String(uuid || '')); })
      || new Set(txUuids.map(function (uuid) { return String(uuid).toLowerCase(); })).size !== ordered.length) {
    throw new Error('Relayr did not bind every quoted transaction to a unique ID. Nothing was paid.');
  }
  // Freeze the exact request-to-transaction mapping returned with this quote. Only these small hashes/UUIDs are
  // persisted; calldata stays in memory. Status polling later requires the API's bundle UUID, tx UUID, and echoed
  // request to match this mapping before it may accept a success or clear a paid receipt.
  body.expected_transactions = ordered.map(function (request, index) {
    return {
      txUuid: String(txUuids[index]).toLowerCase(),
      requestHash: relayrRequestFingerprint(request),
      chain: Number(request.chain),
    };
  });
  return body;
}

function normalizedRelayrQuantity(value, fallback) {
  if (value == null && fallback !== undefined) value = fallback;
  try {
    var numeric = BigInt(value);
    if (numeric < 0n) throw new Error('negative');
    return numeric.toString();
  } catch (_) { throw new Error('Relayr returned a malformed transaction quantity.'); }
}

// Canonical hash of the complete CallRequest schema Relayr accepts/echoes. This is intentionally independent of
// object key order and numeric string formatting, while binding every client-controlled submitted field. Relayr
// estimates and echoes `gas_limit` even when the client omitted it, so that server-added field is deliberately
// excluded; chain, target, calldata, value and our assigned virtual nonce remain exact.
export function relayrRequestFingerprint(request) {
  var chain = Number(request && request.chain);
  var target = String(request && request.target || '').toLowerCase();
  var data = request && request.data == null ? '0x' : String(request.data).toLowerCase();
  var virtualNonce = Number(request && request.virtual_nonce);
  if (!Number.isSafeInteger(chain) || chain < 1 || !isAddress(target, { strict: false })
      || !/^0x(?:[0-9a-f]{2})*$/i.test(data) || data.length > 2_000_002
      || !Number.isSafeInteger(virtualNonce) || virtualNonce < 0) {
    throw new Error('Relayr returned a malformed transaction request.');
  }
  var normalized = {
    chain: chain, target: target, data: data,
    value: normalizedRelayrQuantity(request && request.value, 0),
    virtualNonce: virtualNonce,
  };
  return keccak256(stringToHex(JSON.stringify(normalized)));
}

// Send the single prepaid payment that funds execution on every chain. The HTTP quote is authenticated against
// the exact bundle UUID and immutable payment runtime, then shown as a second exact transaction review before
// the wallet opens. Returns the payment tx hash.
export async function relayrPay(payment, expectedAccount, onSubmitted, expectedBundleUuid, reverify) {
  if (getViewAs()) throw new Error(VIEW_AS_TX_ERROR);
  var details = relayrPaymentDetails(payment, expectedBundleUuid);
  var chainId = details.chainId;
  var wallet = getWalletClient();
  if (!wallet) throw new Error('Connect a wallet first');
  var account = getAccount();
  if (!account) throw new Error('Connect a wallet first');
  if (expectedAccount && account.toLowerCase() !== expectedAccount.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var pub = createPublicClientForChain(chainId);
  await requireRelayrPaymentRuntime(pub);
  if (reverify) await reverify();

  var approved = await confirmTransactionModal({
    summary: {
      action: 'Fund this exact Relayr bundle',
      rows: [
        ['Bundle ID', details.bundleUuid],
        ['Payment selector', RELAYR_PAYMENT_SELECTOR],
        ['Payment deadline', new Date(Number(details.deadline) * 1000).toISOString()],
        ['Native value', details.amount.toString() + ' wei'],
      ],
    },
    chain: CHAINS[chainId].name || ('Chain ' + chainId), chainId: chainId,
    contract: 'Relayr prepaid payment', address: details.target,
    function: 'pay for bundle',
    args: { bundleUuid: details.bundleUuid, paymentDeadline: details.deadline.toString(), selector: RELAYR_PAYMENT_SELECTOR },
    calldata: details.calldata, value: details.amount,
  }, {
    title: 'Review Relayr payment', confirmText: 'Agree & pay Relayr',
    description: 'This separate native payment funds the already-reviewed Relayr bundle. Verify the exact destination, value, bundle ID, deadline, selector, and raw calldata before opening your wallet.',
  });
  if (!approved) throw new Error('Cancelled');
  // A review can remain open past the quote deadline or an authority change. Re-decode the same immutable
  // quote and repeat caller-specific freshness checks after it closes, before any simulation or wallet call.
  details = relayrPaymentDetails(payment, expectedBundleUuid);
  if (reverify) await reverify();
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var active = await wallet.getChainId().catch(function () { return null; });
  if (active !== chainId) { await switchChain(chainId); wallet = getWalletClient(); }
  if (!wallet || !getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  await requireRelayrPaymentRuntime(pub);
  await simulateRelayrPayment(pub, account, details);
  details = relayrPaymentDetails(payment, expectedBundleUuid);
  if (reverify) await reverify();
  if (!getAccount() || getAccount().toLowerCase() !== account.toLowerCase()) throw new Error('Connected account changed. Review the Relayr payment again.');
  var hash = await wallet.sendTransaction({
    account: account,
    chain: CHAINS[chainId],
    to: details.target,
    value: details.amount,
    data: details.calldata,
    gas: RELAYR_PAYMENT_GAS,
  });
  if (onSubmitted) { try { onSubmitted(hash); } catch (_) {} }
  var receipt;
  try {
    receipt = await waitForTrackedTransactionReceipt(pub, hash, wallet, chainId);
  } catch (cause) {
    var submitted = new Error('Relayr payment ' + hash + ' was submitted, but confirmation tracking is temporarily unavailable. Do not pay again; resume the saved bundle instead.');
    submitted.name = 'RelayrPaymentSubmittedError';
    submitted.code = 'RELAYR_PAYMENT_SUBMITTED';
    submitted.hash = hash;
    submitted.chainId = chainId;
    submitted.cause = cause;
    throw submitted;
  }
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
  state = String(state || '').toLowerCase();
  return state === 'failed' || state === 'reverted' || state === 'cancelled';
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
  return !!(error && (error.code === 'RELAYR_TIMEOUT' || error.code === 'RELAYR_PAYMENT_SUBMITTED'
    || error.code === 'RELAYR_STATUS_MISMATCH' || error.code === 'RELAYR_STATUS_UNBOUND'
    || error.code === 'RELAYR_POSTCONDITION_PENDING'));
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
    tx_uuid: record && record.tx_uuid ? String(record.tx_uuid) : null,
    status: {
      state: String(record && record.status && record.status.state || ''),
      data: { hash: relayrDestinationHash(record) || null },
    },
  };
}

function sanitizedRelayrSafeExecution(value) {
  if (!value || value.kind !== 'safe-exec') return null;
  var safe = String(value.safe || '').toLowerCase();
  var safeTxHash = String(value.safeTxHash || '').toLowerCase();
  var nonce;
  try { nonce = BigInt(value.nonce); } catch (_) { return null; }
  if (!isAddress(safe, { strict: false }) || !/^0x[0-9a-f]{64}$/.test(safeTxHash)
      || nonce < 0n || nonce > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { kind: 'safe-exec', safe: safe, nonce: nonce.toString(), safeTxHash: safeTxHash };
}

// Attach one reviewed Safe proof to each immutable Relayr request binding. This happens after Relayr returns its
// tx UUIDs, so proof metadata is never sent to or trusted from the quote API. The exact outer calldata is already
// covered by requestHash; the proof supplies only execTransaction's omitted nonce and expected SafeTx hash.
export function bindRelayrSafeExecutions(expectedTransactions, proofs) {
  var expected = Array.isArray(expectedTransactions) ? expectedTransactions : [];
  var values = Array.isArray(proofs) ? proofs : [];
  if (!expected.length || values.length !== expected.length) throw new Error('Could not bind every Relayr Safe execution to its reviewed transaction.');
  return expected.map(function (binding, index) {
    var result = sanitizedRelayrSafeExecution(Object.assign({ kind: 'safe-exec' }, values[index] || {}));
    if (!result || Number(binding.chain) !== Number(values[index] && values[index].chain)) {
      throw new Error('A Relayr Safe execution proof does not match its destination chain.');
    }
    return Object.assign({}, binding, { result: result });
  });
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
    expectedTransactions: (session.expectedTransactions || []).map(function (expected) {
      var result = sanitizedRelayrSafeExecution(expected && expected.result);
      return {
        txUuid: String(expected && expected.txUuid || '').toLowerCase(),
        requestHash: String(expected && expected.requestHash || '').toLowerCase(),
        chain: Number(expected && expected.chain),
        result: result,
      };
    }).filter(function (expected) {
      return RELAYR_UUID_RE.test(expected.txUuid) && /^0x[0-9a-f]{64}$/.test(expected.requestHash)
        && Number.isSafeInteger(expected.chain) && expected.chain > 0;
    }),
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
    session.expectedTransactions = Array.isArray(session.expectedTransactions) ? session.expectedTransactions : [];
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

export function relayrBoundStatusRecords(uuid, body, expectedTransactions) {
  if (!body || String(body.bundle_uuid || '').toLowerCase() !== String(uuid || '').toLowerCase()) {
    throw new Error('Relayr status does not match the submitted bundle ID.');
  }
  var expected = Array.isArray(expectedTransactions) ? expectedTransactions : [];
  if (!expected.length) throw new Error('The Relayr receipt is missing its submitted transaction binding.');
  var expectedByUuid = {};
  expected.forEach(function (item) {
    var txUuid = String(item && item.txUuid || '').toLowerCase();
    var requestHash = String(item && item.requestHash || '').toLowerCase();
    if (!RELAYR_UUID_RE.test(txUuid) || !/^0x[0-9a-f]{64}$/.test(requestHash) || expectedByUuid[txUuid]) {
      throw new Error('The Relayr receipt contains an invalid transaction binding.');
    }
    expectedByUuid[txUuid] = { item: item, index: Object.keys(expectedByUuid).length };
  });
  var records = Array.isArray(body.transactions) ? body.transactions : [];
  if (records.length > expected.length) throw new Error('Relayr status contains unexpected transactions.');
  var seen = {}, ordered = [];
  records.forEach(function (record) {
    var txUuid = String(record && record.tx_uuid || '').toLowerCase();
    var match = expectedByUuid[txUuid];
    if (!match || seen[txUuid]) throw new Error('Relayr status contains a duplicate or unsubmitted transaction.');
    if (relayrRequestFingerprint(record.request) !== String(match.item.requestHash).toLowerCase()) {
      throw new Error('Relayr status transaction fields do not match the submitted request.');
    }
    if (relayrStateIsSuccess(record && record.status && record.status.state)
        && !/^0x[0-9a-f]{64}$/i.test(String(relayrDestinationHash(record) || ''))) {
      throw new Error('Relayr reported success without a valid destination transaction hash.');
    }
    seen[txUuid] = true;
    ordered[match.index] = record;
  });
  var complete = ordered.filter(Boolean);
  if (complete.length === expected.length
      && complete.every(function (record) { return relayrStateIsSuccess(record && record.status && record.status.state); })
      && body.payment_received !== true) {
    throw new Error('Relayr reported successful transactions without binding the confirmed payment.');
  }
  return complete;
}

// Poll GET /v1/bundle/{uuid} every `intervalMs` until every transaction reports Success/Completed.
// Calls onUpdate(transactions[]) each tick. Resolves with the final transactions; rejects with a structured
// RelayrExecutionError on a terminal Failed record or timeout. A timeout means outcome unknown, not failed.
// Each transaction's destination hash lives at status.data.hash or status.data.transaction.hash.
export function relayrPoll(uuid, onUpdate, intervalMs, timeoutMs, expectedCount, expectedTransactions) {
  intervalMs = intervalMs || 2500;
  timeoutMs = timeoutMs || 5 * 60 * 1000;
  expectedCount = Math.max(1, Number(expectedCount) || 1);
  expectedTransactions = Array.isArray(expectedTransactions) ? expectedTransactions : [];
  if (!expectedTransactions.length || expectedTransactions.length !== expectedCount) {
    return Promise.reject(relayrExecutionError('The saved Relayr receipt is missing an exact transaction binding.', 'RELAYR_STATUS_UNBOUND', uuid, [], true));
  }
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
        var txs;
        try { txs = relayrBoundStatusRecords(uuid, body, expectedTransactions); }
        catch (error) { return reject(relayrExecutionError((error && error.message) || 'Relayr returned mismatched bundle status.', 'RELAYR_STATUS_MISMATCH', uuid, lastRecords, true)); }
        lastRecords = txs;
        if (onUpdate) onUpdate(txs, body);
        if (txs.length === expectedCount && txs.every(function (t) { return relayrStateIsSuccess(t && t.status && t.status.state); })) return resolve(txs);
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

// API status is not an onchain receipt. After the bundle/tx UUID and echoed-request bindings pass, fetch every
// reported destination transaction from its expected chain and match the exact outer `{to,input,value}` plus a
// successful receipt. A compromised status endpoint therefore cannot clear a paid receipt with invented hashes.
export async function verifyRelayrDestinationRecords(expectedTransactions, records, clientFactory) {
  var expected = Array.isArray(expectedTransactions) ? expectedTransactions : [];
  var results = Array.isArray(records) ? records : [];
  if (!expected.length || expected.length !== results.length) {
    throw new Error('Relayr completion does not match the submitted transaction count.');
  }
  clientFactory = clientFactory || createPublicClientForChain;
  var seenHashes = new Set();
  await Promise.all(results.map(async function (record, index) {
    var binding = expected[index];
    var request = record && record.request;
    if (!binding || relayrRequestFingerprint(request) !== String(binding.requestHash || '').toLowerCase()) {
      throw new Error('The saved Relayr transaction binding does not match the reviewed request.');
    }
    var hash = String(relayrDestinationHash(record) || '');
    if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error('Relayr did not return a valid destination transaction hash.');
    if (seenHashes.has(hash.toLowerCase())) throw new Error('Relayr returned the same destination transaction for multiple submitted entries.');
    seenHashes.add(hash.toLowerCase());
    var client = clientFactory(Number(request.chain));
    if (!client || typeof client.getTransaction !== 'function' || typeof client.getTransactionReceipt !== 'function') {
      throw new Error('The destination RPC cannot verify Relayr completion.');
    }
    var loaded = await Promise.all([
      client.getTransaction({ hash: hash }),
      client.getTransactionReceipt({ hash: hash }),
    ]);
    var transaction = loaded[0], receipt = loaded[1];
    if (!receipt || receipt.status !== 'success' || !transaction || !transaction.to
        || (receipt.transactionHash && String(receipt.transactionHash).toLowerCase() !== hash.toLowerCase())
        || String(transaction.to).toLowerCase() !== String(request.target || '').toLowerCase()
        || String(transaction.input || transaction.data || '').toLowerCase() !== String(request.data || '0x').toLowerCase()
        || BigInt(transaction.value || 0) !== BigInt(request.value || 0)) {
      throw new Error('Relayr’s destination transaction does not match the reviewed request on chain ' + request.chain + '.');
    }
    var safeProof = sanitizedRelayrSafeExecution(binding.result);
    if (binding.result && !safeProof) throw new Error('The saved Relayr Safe execution proof is malformed.');
    if (safeProof) {
      if (String(request.target || '').toLowerCase() !== safeProof.safe || BigInt(request.value || 0) !== 0n) {
        throw new Error('The saved Relayr Safe execution proof does not match its outer request.');
      }
      var decoded = decodeSafeExecRelayrTx(Number(request.chain), safeProof.safe, request.data, safeProof.nonce);
      if (String(decoded.safeTxHash).toLowerCase() !== safeProof.safeTxHash) {
        throw new Error('The saved Relayr Safe transaction hash does not match its exact execution calldata.');
      }
      if (!hasExactSafeExecutionSuccess(receipt.logs, safeProof.safe, safeProof.safeTxHash)) {
        throw new Error('The Safe did not emit ExecutionSuccess for the reviewed transaction.');
      }
      var liveNonce = BigInt(await readSafeUintBounded(client, safeProof.safe, 'nonce'));
      if (liveNonce <= BigInt(safeProof.nonce)) throw new Error('The Safe nonce did not advance after Relayr execution.');
    }
  }));
  return true;
}
