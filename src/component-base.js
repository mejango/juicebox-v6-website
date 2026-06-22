// src/component-base.js
// Shared building blocks for all component widgets

import { getAccount, getWalletClient, createPublicClientForChain, connect, disconnect, onWalletChange, switchChain, eagerConnect, getProviders } from './wallet.js';
import { CHAINS, getManifestChains, getChainTokens, contractNameByAddress } from './chain.js';
import { parseAmount, formatAmount } from './encoding.js';
import { renderError } from './errors.js';
import { decodeFunctionData, isAddress } from 'viem';
import { getAddress, meta, getABI } from './abi-registry.js';

// Reverse index (chainId:loweraddr → deployment name) so a confirm modal can show WHICH known contract an
// address is. Suckers and other per-project deployments aren't in the registry — callers pass contractName.
var _addrToName = null;
function buildAddrIndex() {
  _addrToName = {};
  try {
    Object.keys(meta).forEach(function (name) {
      var addrs = meta[name] && meta[name].addresses; if (!addrs) return;
      Object.keys(addrs).forEach(function (cid) {
        var a = (addrs[cid] || '').toLowerCase();
        if (a) _addrToName[cid + ':' + a] = meta[name].deploymentName || meta[name].contractName || name;
      });
    });
  } catch (_) {}
}
export function resolveContractName(address, chainId) {
  if (!address) return null;
  if (!_addrToName) buildAddrIndex();
  return _addrToName[chainId + ':' + String(address).toLowerCase()] || null;
}

// A canonical type string (expands tuples to their component types) for an ABI param.
function abiTypeOf(p) {
  if (p && typeof p.type === 'string' && p.type.indexOf('tuple') === 0 && p.components) {
    return '(' + p.components.map(abiTypeOf).join(',') + ')' + p.type.slice(5);
  }
  return p ? p.type : '';
}
// Human-readable signature of the function being called: `name(type arg, …) [payable|view] [returns (…)]`.
export function abiSignature(abi, functionName) {
  if (!Array.isArray(abi)) return functionName;
  var f = abi.filter(function (x) { return x.type === 'function' && x.name === functionName; })[0];
  if (!f) return functionName;
  var ins = (f.inputs || []).map(function (i) { return abiTypeOf(i) + (i.name ? ' ' + i.name : ''); }).join(', ');
  var mut = (f.stateMutability && f.stateMutability !== 'nonpayable') ? ' ' + f.stateMutability : '';
  var outs = (f.outputs && f.outputs.length) ? ' returns (' + f.outputs.map(abiTypeOf).join(', ') + ')' : '';
  return f.name + '(' + ins + ')' + mut + outs;
}

export { getAccount, getWalletClient, createPublicClientForChain, connect, disconnect, onWalletChange, switchChain, eagerConnect, getProviders };
export { CHAINS, getManifestChains, getChainTokens };
export { parseAmount, formatAmount };
export { renderError };
export { getAddress };

export var NATIVE_TOKEN = '0x000000000000000000000000000000000000EEEe';
export var ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// --- ABI fragments reused across components ---

export var controllerOfAbi = [{
  type: 'function', name: 'controllerOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ name: '', type: 'address' }],
}];

export var erc20ApproveAbi = [{
  type: 'function', name: 'approve', stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
}];

export var erc20AllowanceAbi = [{
  type: 'function', name: 'allowance', stateMutability: 'view',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];

export var erc20DecimalsAbi = [{
  type: 'function', name: 'decimals', stateMutability: 'view',
  inputs: [],
  outputs: [{ name: '', type: 'uint8' }],
}];

// --- DOM helpers ---

export function el(tag, className) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

export function truncAddr(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

// Pretty-print a tx payload for the confirm/decode views: BigInt → decimal string, then unquote
// JSON keys ({ "to": … } → { to: … }) so it reads like a config rather than wire JSON.
export function formatPayloadJson(obj) {
  return JSON.stringify(obj, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }, 2)
    .replace(/^(\s*)"([A-Za-z_][\w]*)":/gm, '$1$2:');
}

// The user-facing message from a thrown error: viem's concise `shortMessage` if present, else `.message`,
// else the caller's fallback. One place so every catch handler reads errors the same way.
export function errMessage(e, fallback) {
  return (e && (e.shortMessage || e.message)) || fallback;
}

// One address-format check for the whole app (replaces ~39 inline `/^0x[0-9a-fA-F]{40}$/` regexes).
// strict:false = format only (any case), matching the old regex; the `typeof` guard matches `.test()`'s
// string coercion so isAddr(undefined) === false. addrOrZero coerces a blank/invalid address to 0x0.
export function isAddr(s) {
  return typeof s === 'string' && isAddress(s, { strict: false });
}
export function addrOrZero(s) {
  return (s && isAddr(s)) ? s : ZERO_ADDRESS;
}

// A status-line setter bound to an element: `set(msg, kind)` writes `<baseClass> <kind>` + text.
// Replaces the ~7 copy-pasted `function setStatus(msg, kind){ status.className=…; status.textContent=… }`.
export function makeStatusSetter(elem, baseClass) {
  baseClass = baseClass || 'modal-status';
  return function (msg, kind) {
    elem.className = baseClass + (kind ? ' ' + kind : '');
    elem.textContent = msg;
  };
}

// --- URL hash helpers ---

export function parseHashDefaults(prefix) {
  var hash = window.location.hash || '';
  if (hash.indexOf('#' + prefix) !== 0) return {};
  var qs = hash.indexOf('?') !== -1 ? hash.slice(hash.indexOf('?') + 1) : '';
  if (!qs) return {};
  var params = {};
  qs.split('&').forEach(function(pair) {
    var parts = pair.split('=');
    if (parts.length === 2) params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1]);
  });
  return params;
}

export function buildEmbedUrl(prefix, params) {
  var base = window.location.href.split('#')[0] + '#' + prefix;
  var parts = [];
  var keys = Object.keys(params);
  for (var i = 0; i < keys.length; i++) {
    if (params[keys[i]] != null && params[keys[i]] !== '') {
      parts.push(encodeURIComponent(keys[i]) + '=' + encodeURIComponent(params[keys[i]]));
    }
  }
  return parts.length > 0 ? base + '?' + parts.join('&') : base;
}

// --- Chain discovery ---

export function discoverChains(projectId, callback) {
  var chains = getManifestChains();
  var chainIds = Object.keys(chains).map(Number);

  var hasAnyAddress = false;
  for (var ci = 0; ci < chainIds.length; ci++) {
    if (getAddress('JBDirectory', chainIds[ci])) { hasAnyAddress = true; break; }
  }

  if (!hasAnyAddress) {
    callback(chainIds);
    return;
  }

  var promises = chainIds.map(function(chainId) {
    var directoryAddr = getAddress('JBDirectory', chainId);
    if (!directoryAddr) return Promise.resolve({ chainId: chainId, exists: false });

    var client = createPublicClientForChain(chainId);
    if (!client) return Promise.resolve({ chainId: chainId, exists: false });

    return client.readContract({
      address: directoryAddr,
      abi: controllerOfAbi,
      functionName: 'controllerOf',
      args: [BigInt(projectId)],
    }).then(function(result) {
      return { chainId: chainId, exists: result && result !== ZERO_ADDRESS };
    }).catch(function() {
      return { chainId: chainId, exists: false };
    });
  });

  Promise.all(promises).then(function(results) {
    var live = [];
    for (var r = 0; r < results.length; r++) {
      if (results[r].exists) live.push(results[r].chainId);
    }
    callback(live.length > 0 ? live : chainIds);
  });
}

// --- Shared UI builders ---

// Combined project ID + chain selector. The chain summary sits ABOVE the
// project ID input as a compact "on <chain>" link — click it to reveal the
// full chain picker (mainnet/testnet toggle + chain pills). Use this in any
// pretty action where the project ID is interpreted relative to a specific
// chain (i.e. NOT project-creation flows like launchProjectFor or
// queueRulesetsOf).
export function createProjectAndChainInput(state, onProjectUpdate, onChainChange) {
  var section = el('div', 'component-section project-chain-section');

  // Label
  var label = el('label', 'input-label');
  label.innerHTML = 'project ID <span class="type-hint">uint256</span>';
  section.appendChild(label);

  // Chain summary + (optional) full picker — ABOVE the project ID input.
  // Always render, even before a project ID has been entered. Before discovery
  // the picker shows all manifest chains for the current network; after
  // discovery it shows only the chains the project lives on.
  var chains = getManifestChains();
  if (!state.network) state.network = 'mainnet';

  function defaultChainForNetwork() {
    var want = state.network === 'testnet';
    var keys = Object.keys(chains);
    for (var k = 0; k < keys.length; k++) {
      var c = chains[keys[k]];
      if (!!c.testnet === want) return Number(keys[k]);
    }
    return Number(keys[0]);
  }

  var summaryChainId = state.selectedChain || defaultChainForNetwork();
  var summaryCh = chains[String(summaryChainId)];
  var summaryName = summaryCh ? summaryCh.name : 'select chain';

  var chainWrap = el('div', 'project-chain-wrap');

  var summary = document.createElement('a');
  summary.className = 'project-chain-summary';
  summary.href = '#';
  summary.textContent = (state._showChainPicker ? '▾' : '▸') + ' on ' + summaryName;
  chainWrap.appendChild(summary);

  var picker = el('div', 'project-chain-picker');
  picker.style.display = state._showChainPicker ? '' : 'none';

  var netSelect = el('select', 'network-dropdown');
  var mainOpt = document.createElement('option');
  mainOpt.value = 'mainnet';
  mainOpt.textContent = 'mainnet';
  if (state.network === 'mainnet') mainOpt.selected = true;
  netSelect.appendChild(mainOpt);
  var testOpt = document.createElement('option');
  testOpt.value = 'testnet';
  testOpt.textContent = 'testnet';
  if (state.network === 'testnet') testOpt.selected = true;
  netSelect.appendChild(testOpt);
  netSelect.addEventListener('change', function() {
    state.network = netSelect.value;
    onChainChange(null);
  });
  picker.appendChild(netSelect);

  // Use discovered chains when available; otherwise show all manifest chains
  // for the current network so the user can pre-select a chain.
  var sourceChainIds = (state.liveChains && state.liveChains.length > 0)
    ? state.liveChains
    : Object.keys(chains).map(Number);
  var isTestnet = state.network === 'testnet';
  for (var i = 0; i < sourceChainIds.length; i++) {
    (function(cid) {
      var ch = chains[String(cid)];
      if (!ch) return;
      if (isTestnet !== !!ch.testnet) return;
      var pill = el('button', 'chain-pill' + (ch.testnet ? ' testnet' : '') + (summaryChainId === cid ? ' selected' : ''));
      pill.textContent = ch.name;
      pill.addEventListener('click', function() { onChainChange(cid); });
      picker.appendChild(pill);
    })(sourceChainIds[i]);
  }
  chainWrap.appendChild(picker);

  summary.addEventListener('click', function(e) {
    e.preventDefault();
    state._showChainPicker = !state._showChainPicker;
    picker.style.display = state._showChainPicker ? '' : 'none';
    summary.textContent = (state._showChainPicker ? '▾' : '▸') + ' on ' + summaryName;
  });

  section.appendChild(chainWrap);

  if (state.phase === 'discovering') {
    var disc = el('div', 'component-status component-discovering');
    disc.textContent = 'Searching chains...';
    section.appendChild(disc);
  }

  // Project ID input
  var input = el('input', 'field numeric-field');
  input.type = 'text';
  input.placeholder = '1';
  input.value = state.projectId;
  input.addEventListener('input', function() {
    state.projectId = input.value.trim();
    onProjectUpdate();
  });
  section.appendChild(input);

  return section;
}

export function createBeneficiaryInput(state, onUpdate) {
  var section = el('div', 'component-section');
  var label = el('label', 'input-label');
  label.textContent = 'beneficiary';
  section.appendChild(label);
  var pills = el('div', 'token-pills');
  var selfPill = el('button', 'pill' + (state.beneficiary === 'self' ? ' selected' : ''));
  selfPill.textContent = 'self (connected wallet)';
  selfPill.addEventListener('click', function() {
    state.beneficiary = 'self';
    onUpdate();
  });
  pills.appendChild(selfPill);
  var customPill = el('button', 'pill' + (state.beneficiary === 'custom' ? ' selected' : ''));
  customPill.textContent = 'custom address';
  customPill.addEventListener('click', function() {
    state.beneficiary = 'custom';
    onUpdate();
  });
  pills.appendChild(customPill);
  section.appendChild(pills);
  if (state.beneficiary === 'custom') {
    var input = el('input', 'field address-field');
    input.type = 'text';
    input.placeholder = '0x...';
    input.value = state.customBeneficiary || '';
    input.addEventListener('input', function() {
      state.customBeneficiary = input.value.trim();
      onUpdate();
    });
    section.appendChild(input);
  }
  return section;
}

export function createWalletButton(label, onClick, permissionNote) {
  var actions = el('div', 'fn-actions');
  actions.style.padding = '0';
  actions.style.marginTop = '10px';

  var btn = el('button', '');
  function update() {
    if (getAccount()) {
      btn.className = 'btn btn-transact';
      btn.textContent = label;
    } else {
      btn.className = 'btn btn-connect';
      btn.textContent = 'CONNECT WALLET';
    }
  }
  update();
  onWalletChange(update);

  btn.addEventListener('click', function() {
    if (!getAccount()) {
      connect().catch(function() {});
      return;
    }
    onClick();
  });
  actions.appendChild(btn);

  if (permissionNote) {
    var noteWrap = el('div', 'component-permission-note');
    noteWrap.textContent = permissionNote;
    actions.appendChild(noteWrap);
  }

  return actions;
}

// --- Transaction execution pipeline ---

// Build a copy-pasteable prompt the user can feed to an LLM to sanity-check a transaction before signing.
// Includes the exact payload, block-explorer link(s) to the target contract(s), and a safety checklist.
export function buildTxAuditPrompt(payload) {
  var lines = [];
  lines.push("I'm about to sign a blockchain transaction in the Juicebox **V6** web app (the `nana` V6 / revnet V6 protocol release — NOT Juicebox v1/v2/v3/v4/v5). Act as a careful security reviewer: independently verify the transaction, confirm it matches my intent, and only then give a go/no-go. Assume I could be the target of a scam or a spoofed UI — trust the on-chain data and the V6 source code over anything the page says. When you look up contract source, use ONLY the V6 repositories (names ending in `-v6`); same-named repos without that suffix are older protocol versions and will mislead you.");
  lines.push('');
  lines.push('Transaction payload — exactly what will be sent on-chain:');
  lines.push('```json');
  lines.push(JSON.stringify(payload, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }, 2));
  lines.push('```');
  lines.push('');

  // 1) The exact UI build, so the reviewer can audit the button I clicked.
  var site = currentSiteRef();
  lines.push('Audit the exact app build I am using:');
  if (site) {
    lines.push('- This UI was loaded from IPFS CID `' + site.cid + '` — fetch it (e.g. ' + site.gateway + ' or ipfs://' + site.cid + ') and inspect src/app.js / the create + transaction code to confirm the button I clicked builds exactly this payload and nothing hidden.');
  } else {
    lines.push('- This UI was loaded from ' + currentOrigin() + ' (not an IPFS gateway). If it claims to be the Juicebox V6 app but is not served from a known IPFS build, treat that as a red flag.');
  }
  lines.push('');

  // 2 + 3) Contract source: ecosystem umbrella + the specific repo(s) for the target contract(s), + explorers.
  lines.push('Verify the contract source — this is Juicebox **V6** (a.k.a. the `nana` V6 / revnet V6 release). CRITICAL: audit only the **V6** repositories — their names end in `-v6`. The older same-named repos WITHOUT the `-v6` suffix (e.g. `Bananapus/nana-suckers`, `Bananapus/nana-core`) are PRIOR protocol versions and will NOT match the deployed bytecode — do not use them. Match against each repo\'s default branch:');
  lines.push('- Full Juicebox V6 ecosystem (umbrella of all V6 repos): https://github.com/Bananapus/version-6');
  contractSourceRefs(payload).forEach(function (r) { lines.push('- ' + r); });
  auditLinksFromPayload(payload).forEach(function (l) { lines.push('- ' + l.label + ' on-chain (confirm verified source + legit address): ' + l.url); });
  lines.push('');

  // 5) Expected wallet data — what I should match on my wallet / hardware wallet before approving.
  var w = walletExpectations(payload);
  if (w.length) {
    lines.push('What I should see and verify in my wallet / hardware wallet before approving — if any of these differ, tell me to REJECT:');
    w.forEach(function (e) { lines.push('- ' + e); });
    lines.push('');
  }

  lines.push('Check specifically:');
  lines.push('1. Decode the `function` and each `arg` — do they match what I believe I am doing?');
  lines.push('2. Is `value` (native token sent with the call) what I expect? Flag any unexpected non-zero value.');
  lines.push('3. If there is an `erc20Approval`, is the amount bounded and the spender expected? Warn on unlimited / uint256-max approvals.');
  lines.push('4. Are any addresses in the args recipients of funds, tokens, ownership, or operator/permission rights? Are they my address or one I explicitly named?');
  lines.push('5. For cross-chain (relayr) calls, is the SAME change applied consistently across every listed chain, with no extra chain slipped in?');
  lines.push('6. Any sign of a drain, ownership/operator transfer, or permission grant I did not intend?');
  lines.push('');

  // 4) Quiz me on intent before the verdict.
  lines.push('Before giving your verdict, QUIZ me to confirm I understand what I am signing: ask me 2–4 short questions in plain English about what I expect this transaction to do (e.g. what is being created/sent, to whom, for how much, on which chain(s), and what control I am keeping or giving away). Wait for my answers, then compare them against the decoded payload and flag any mismatch between my stated intent and what the transaction actually does.');
  lines.push('');
  lines.push('Juicebox V6 docs: https://docs.juicebox.money. If the target address is not a recognizable Juicebox V6 deployment, warn me explicitly.');
  lines.push('');
  lines.push('After the quiz, end with a one-line verdict: SAFE TO SIGN / DO NOT SIGN / NEEDS MORE INFO, followed by the top reasons.');
  return lines.join('\n');
}

// The IPFS CID this UI was served from (path-gateway /ipfs/<cid>/ or <cid>.ipfs.* subdomain), or null.
function currentSiteRef() {
  try {
    var loc = window.location;
    var pm = (loc.pathname || '').match(/\/ipfs\/(ba[0-9a-z]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})/i);
    if (pm) return { cid: pm[1], gateway: loc.origin + '/ipfs/' + pm[1] + '/' };
    var sm = (loc.hostname || '').match(/^(ba[0-9a-z]{20,})\.ipfs\./i);
    if (sm) return { cid: sm[1], gateway: loc.origin + '/' };
  } catch (_) { /* no window */ }
  return null;
}
function currentOrigin() { try { return window.location.origin; } catch (_) { return 'an unknown origin'; } }

// GitHub repo for a Juicebox V6 contract by name. The deployed bytecode lives in the V6 repos — their names
// end in `-v6`. The older same-named repos (no suffix) are PRIOR protocol versions and will NOT match; always
// cite the `-v6` repo on its default branch so a reviewer doesn't audit the wrong version.
function contractRepoFor(name) {
  if (!name || /^0x/i.test(name)) return null;
  if (name === 'ERC2771Forwarder') return 'OpenZeppelin ERC2771Forwarder: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/metatx/ERC2771Forwarder.sol';
  if (/Sucker/.test(name)) return name + ' (nana-suckers-v6): https://github.com/Bananapus/nana-suckers-v6';
  if (/Buyback/.test(name)) return name + ' (nana-buyback-hook-v6): https://github.com/Bananapus/nana-buyback-hook-v6';
  if (/^JB721/.test(name)) return name + ' (nana-721-hook-v6): https://github.com/Bananapus/nana-721-hook-v6';
  if (name === 'JBOmnichainDeployer') return name + ' (nana-omnichain-deployers-v6): https://github.com/Bananapus/nana-omnichain-deployers-v6';
  if (name === 'JBRouterTerminalRegistry') return name + ' (nana-router-terminal-v6): https://github.com/Bananapus/nana-router-terminal-v6';
  if (/^REV/.test(name)) return name + ' (revnet-core-v6): https://github.com/rev-net/revnet-core-v6';
  if (/^JB/.test(name)) return name + ' (Juicebox V6): https://github.com/Bananapus/version-6';
  return null;
}
function contractSourceRefs(payload) {
  var names = {};
  if (payload && Array.isArray(payload.chains)) payload.chains.forEach(function (c) { if (c.contract) names[c.contract] = 1; });
  else if (payload && payload.contract) names[payload.contract] = 1;
  return Object.keys(names).map(contractRepoFor).filter(Boolean);
}

// Wei (string/bigint) → decimal ETH string, no trailing zeros.
function weiToEth(v) {
  try {
    var n = BigInt(v || 0); var W = 1000000000000000000n;
    var whole = (n / W).toString(); var frac = (n % W).toString().padStart(18, '0').replace(/0+$/, '');
    return frac ? (whole + '.' + frac) : whole;
  } catch (_) { return String(v); }
}
// Plain "what to verify on your wallet" lines from a confirm payload.
function walletExpectations(payload) {
  if (!payload) return [];
  // Multi-tx flows (e.g. a multichain deploy: { transactions: [...] }). Each chain carries its OWN
  // native value — typically the project creation fee — so never assert a single "0 ETH" expectation.
  var txs = Array.isArray(payload.transactions) ? payload.transactions
          : Array.isArray(payload.chains) ? payload.chains : null;
  if (txs) {
    var multi = ['This action spans ' + txs.length + ' chains — there is one transaction per chain (below). Verify EACH one’s network, "To" address, function and `value`. Each chain sends its own native amount (e.g. the project creation fee), so do NOT expect a single 0 ETH value across them.'];
    txs.forEach(function (t) {
      var bits = [];
      if (t.chain) bits.push(t.chain);
      if (t.address || t.to || t.contract) bits.push('to ' + (t.address || t.to || t.contract));
      if (t.value != null) bits.push('value ' + (typeof t.value === 'string' ? t.value : weiToEth(t.value) + ' ETH'));
      if (bits.length) multi.push(bits.join(' — ') + '.');
    });
    return multi;
  }
  var out = [];
  if (payload.chain) out.push('Network: ' + payload.chain + ' — make sure your wallet is on this network.');
  var to = payload.address || (typeof payload.contract === 'string' && /^0x/.test(payload.contract) ? payload.contract : null);
  if (to) out.push('Recipient / "To" address: ' + to + (payload.contract && !/^0x/.test(payload.contract) ? ' (' + payload.contract + ')' : '') + ' — it must match this exactly.');
  // `value` may be raw wei (bigint/numeric string, from executeTransaction) OR an already-formatted display
  // string like "0.002 ETH" (from openTxConfirm payloads). Detect the latter by the presence of letters and
  // never call BigInt() on it — BigInt("0.002 ETH") throws and would crash the whole audit-prompt build.
  var rawVal = payload.value;
  var preformatted = typeof rawVal === 'string' && /[a-zA-Z]/.test(rawVal);
  var valDisp = preformatted ? rawVal : (weiToEth(rawVal || 0) + ' ETH');
  var valZero = false;
  if (!preformatted) { try { valZero = BigInt(rawVal || 0) === 0n; } catch (_) { valZero = false; } }
  out.push('Amount / value: ' + valDisp + (valZero ? ' (zero — your wallet should show no ETH being sent)' : '') + '.');
  if (payload.function) out.push('Function being called: ' + payload.function + (payload.abi ? ' — signature ' + payload.abi : '') + '.');
  out.push('If your wallet shows a different "To" address, a higher amount, or a different function/network than the above, REJECT the transaction.');
  return out;
}

// Derive block-explorer address links from a confirm payload (direct: {chain,contract}; relayr: {chains:[{chain,contract}]}).
function auditLinksFromPayload(payload) {
  var out = [];
  function explorer(chainName, addr) {
    if (!addr) return null;
    var id = null;
    for (var k in CHAINS) { if (CHAINS[k] && CHAINS[k].name === chainName) { id = k; break; } }
    var be = id && CHAINS[id].blockExplorers && CHAINS[id].blockExplorers.default;
    if (!be || !be.url) return null;
    return be.url.replace(/\/$/, '') + '/address/' + addr;
  }
  if (payload && (Array.isArray(payload.chains) || Array.isArray(payload.transactions))) {
    (payload.transactions || payload.chains).forEach(function (c) { var u = explorer(c.chain, c.contract || c.address || c.to); if (u) out.push({ label: c.chain + ' target', url: u }); });
  } else if (payload) {
    var u = explorer(payload.chain, payload.contract || payload.address || payload.to);
    if (u) out.push({ label: 'Target contract', url: u });
  }
  return out;
}

// Append a subtle "[copy prompt to verify with your LLM]" link that copies buildTxAuditPrompt(payload).
export function appendAuditPromptLink(container, payload) {
  var DEFAULT = '[copy tx audit prompt]';
  var wrap = el('div', 'tx-audit-prompt');
  var link = el('a', 'tx-audit-link'); link.href = '#'; link.textContent = DEFAULT;
  link.addEventListener('click', function (e) {
    e.preventDefault();
    var text = buildTxAuditPrompt(payload);
    var p = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(text) : Promise.reject();
    p.then(function () { link.textContent = '[copied — paste into your LLM]'; })
     .catch(function () { link.textContent = '[copy failed — select the payload above]'; });
    setTimeout(function () { link.textContent = DEFAULT; }, 2200);
  });
  wrap.appendChild(link); container.appendChild(wrap);
}

// Pre-sign confirmation modal — shows the exact transaction payload and resolves true/false.
// Self-contained (no dependency on discover.js) so every executeTransaction caller can gate on it.
// Reuses the global modal/confirm CSS classes for a consistent look.
// Append a `// <ContractName>` comment to any display-JSON line whose value is a known JB address,
// so a reviewer can associate raw addresses with contract labels (e.g. JBRouterTerminalRegistry).
// Display-only — the result is not re-parsed as JSON.
function annotateAddresses(text) {
  return text.split('\n').map(function (line) {
    if (line.indexOf('//') !== -1) return line; // already annotated
    var m = line.match(/(0x[0-9a-fA-F]{40})/);
    if (!m) return line;
    var name = contractNameByAddress(m[1]);
    return name ? (line + '  // ' + name) : line;
  }).join('\n');
}

// Annotate ruleset start timestamps (mustStartAtOrAfter / startsAtOrAfter) with a human date + a note that
// it's a fixed deploy-time value, identical on every chain so a multichain project starts in lockstep.
function annotateTimestamps(text) {
  return text.split('\n').map(function (line) {
    if (line.indexOf('//') !== -1) return line; // already annotated
    var m = line.match(/(?:mustStartAtOrAfter|startsAtOrAfter):\s*"?(\d+)"?,?\s*$/);
    if (!m) return line;
    var ts = Number(m[1]);
    if (ts === 0) return line + '  // 0 = starts at the deploy block (this chain only)';
    var when; try { when = new Date(ts * 1000).toUTCString(); } catch (_) { when = ''; }
    return line + '  // ' + when + ' — when this ruleset starts. Fixed at deploy (~10 min ahead) and identical on every chain so a multichain project begins in lockstep, not at each chain’s own block time.';
  }).join('\n');
}

// ── Human-legible calldata decoding for the confirm modal ───────────────────
// Format a single decoded arg value for display (no hex parsing required by the user).
function formatArgValue(type, v) {
  if (v == null) return '';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') {
    if ((type || '') === 'address') return v;                 // keep full address (modal annotates it)
    if (/^0x/.test(v)) return v.length > 26 ? (v.slice(0, 12) + '…' + v.slice(-8)) : v; // bytes/hash → truncate
    return JSON.stringify(v);                                  // quote plain strings
  }
  if (Array.isArray(v)) return '[' + v.map(function (x) { return formatArgValue('', x); }).join(', ') + ']';
  try { return JSON.stringify(v, function (k, val) { return typeof val === 'bigint' ? val.toString() : val; }); } catch (_) { return String(v); }
}
// Normalize tx field aliases — builders disagree on names: calldata|data (the raw bytes), function|functionName
// (viem's key), args|rawArgs (the positional array; some payloads also carry a named-object `args`, so only an
// array counts here). Without this, payloads like the auto-issue confirm (data/functionName/rawArgs) render as
// "could not decode" even though the ABI + calldata are present.
function txCalldata(tx) { return tx.calldata || tx.data || null; }
function txFnName(tx) { return tx.function || tx.functionName || null; }
function txArgsArray(tx) { return Array.isArray(tx.args) ? tx.args : (Array.isArray(tx.rawArgs) ? tx.rawArgs : []); }
function shapeDecoded(abi, fnName, argsArr) {
  var frag = abi && abi.filter(function (e) { return e.type === 'function' && e.name === fnName; })[0];
  var inputs = (frag && frag.inputs) || [];
  return { fn: fnName, args: (argsArr || []).map(function (v, i) { var inp = inputs[i] || {}; return { name: inp.name || ('arg' + i), type: inp.type || '', value: formatArgValue(inp.type, v) }; }) };
}
// Decode a tx into { fn, args:[{name,type,value}] } from its raw calldata (preferred) or its
// already-known function+args (single-tx payloads). Null when no ABI/function is resolvable.
export function decodeCallForDisplay(tx) {
  if (!tx) return null;
  var name = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : ((tx.address || tx.to) ? contractNameByAddress(tx.address || tx.to) : null);
  var abi = null; try { if (name) abi = getABI(name); } catch (_) {}
  var cd = txCalldata(tx), fn = txFnName(tx);
  if (cd && cd !== '0x' && abi) {
    try { var dec = decodeFunctionData({ abi: abi, data: cd }); return shapeDecoded(abi, dec.functionName, dec.args); } catch (_) {}
  }
  if (fn) return shapeDecoded(abi, fn, txArgsArray(tx));
  return null;
}
// Rich decode that PRESERVES structure (nested tuples/arrays) so the renderer can build a tree, not a JSON
// blob. Returns { fn, inputs:[abiInput]|null, values:[raw] } (inputs null when no ABI — caller falls back).
function decodeCallRich(tx) {
  if (!tx) return null;
  var name = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : ((tx.address || tx.to) ? contractNameByAddress(tx.address || tx.to) : null);
  var abi = null; try { if (name) abi = getABI(name); } catch (_) {}
  var cd = txCalldata(tx), fn = txFnName(tx), ar = txArgsArray(tx);
  if (cd && cd !== '0x' && abi) {
    try {
      var dec = decodeFunctionData({ abi: abi, data: cd });
      var frag = abi.filter(function (e) { return e.type === 'function' && e.name === dec.functionName; })[0];
      return { fn: dec.functionName, inputs: (frag && frag.inputs) || [], values: Array.from(dec.args || []) };
    } catch (_) {}
  }
  // Curated named-object args: the pay/swap/add-liquidity confirms pass a human-readable { name: value } object
  // (values already formatted, e.g. "…wei (1 ETH)") instead of a positional array. Render its entries directly
  // so the values aren't blank — mapping it onto the ABI's positional inputs would leave every value undefined.
  if (tx.args && typeof tx.args === 'object' && !Array.isArray(tx.args)) {
    return { fn: fn || '(call)', inputs: null, shaped: Object.keys(tx.args).map(function (k) {
      var v = tx.args[k];
      // Curated values are already display strings (e.g. a full beneficiary address) — show them as-is, NOT
      // through formatArgValue, which truncates addresses (a confirm must show the full recipient).
      return { name: k, type: '', value: typeof v === 'string' ? v : formatArgValue('', v) };
    }) };
  }
  if (fn) {
    var frag2 = abi && abi.filter(function (e) { return e.type === 'function' && e.name === fn; })[0];
    if (frag2) return { fn: fn, inputs: frag2.inputs || [], values: ar };
    return { fn: fn, inputs: null, shaped: shapeDecoded(abi, fn, ar).args };
  }
  return null;
}

// One decoded arg as a DOM row. Recurses into tuples / tuple[] so each field sits on its own indented line
// (the "pretty" tree view) instead of a single inline JSON blob.
function renderArgNode(input, value, depth) {
  var type = input.type || '';
  var baseType = type.replace(/\[\]$/, '');
  var isArray = /\[\]$/.test(type);
  var label = (input.name || '') + (type ? ' (' + type + ')' : '');
  if (input.components && baseType === 'tuple') {
    var wrap = el('div', 'tx-decoded-arg'); wrap.style.marginLeft = (depth * 14) + 'px';
    var head = el('span', 'tx-decoded-argname'); head.textContent = label + ':'; wrap.appendChild(head);
    if (isArray) {
      var arr = value || [];
      if (!arr.length) { var empty = el('span', 'tx-decoded-argval'); empty.textContent = ' []'; wrap.appendChild(empty); return wrap; }
      arr.forEach(function (item, idx) {
        var ih = el('div', 'tx-decoded-arg'); ih.style.marginLeft = ((depth + 1) * 14) + 'px';
        var ik = el('span', 'tx-decoded-argname'); ik.textContent = '[' + idx + ']:'; ih.appendChild(ik); wrap.appendChild(ih);
        input.components.forEach(function (c, ci) { wrap.appendChild(renderArgNode(c, item ? (item[c.name] !== undefined ? item[c.name] : item[ci]) : undefined, depth + 2)); });
      });
    } else {
      input.components.forEach(function (c, ci) { wrap.appendChild(renderArgNode(c, value ? (value[c.name] !== undefined ? value[c.name] : value[ci]) : undefined, depth + 1)); });
    }
    return wrap;
  }
  var r = el('div', 'tx-decoded-arg'); r.style.marginLeft = (depth * 14) + 'px';
  var k = el('span', 'tx-decoded-argname'); k.textContent = label + ': ';
  var val = el('span', 'tx-decoded-argval'); val.textContent = formatArgValue(type, value);
  r.appendChild(k); r.appendChild(val);
  return r;
}

export function renderDecodedTx(tx) {
  var box = el('div', 'tx-decoded');
  if (tx.chain) { var ch = el('div', 'tx-decoded-chain'); ch.textContent = tx.chain; box.appendChild(ch); }
  var who = el('div', 'tx-decoded-target');
  var nm = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : null;
  who.textContent = (nm ? nm + ' | ' : '') + (tx.address || tx.to || tx.contract || '');
  box.appendChild(who);
  var rich = decodeCallRich(tx);
  if (rich) {
    var call = el('div', 'tx-decoded-call');
    var hasArgs = rich.inputs ? rich.inputs.length : (rich.shaped && rich.shaped.length);
    var fn = el('div', 'tx-decoded-fn'); fn.textContent = rich.fn + (hasArgs ? '' : '()'); call.appendChild(fn);
    if (rich.inputs) {
      rich.inputs.forEach(function (inp, i) { call.appendChild(renderArgNode(inp, rich.values[i], 0)); });
    } else {
      (rich.shaped || []).forEach(function (a) {
        var r = el('div', 'tx-decoded-arg');
        var k = el('span', 'tx-decoded-argname'); k.textContent = a.name + (a.type ? ' (' + a.type + ')' : '') + ': ';
        var val = el('span', 'tx-decoded-argval'); val.textContent = a.value;
        r.appendChild(k); r.appendChild(val); call.appendChild(r);
      });
    }
    box.appendChild(call);
  } else {
    var raw = el('div', 'tx-decoded-unknown'); raw.textContent = 'Could not decode this call — review the raw data below before signing.'; box.appendChild(raw);
  }
  if (tx.erc20Approval) {
    var ap = el('div', 'tx-decoded-arg'); ap.textContent = 'ERC-20 approval: ' + formatArgValue('uint256', tx.erc20Approval.amount) + ' to ' + tx.erc20Approval.spender; box.appendChild(ap);
  }
  if (tx.value != null && String(tx.value) !== '0' && String(tx.value) !== '0n') {
    var v = el('div', 'tx-decoded-value'); v.textContent = 'Value: ' + (typeof tx.value === 'bigint' ? tx.value.toString() + ' wei' : tx.value); box.appendChild(v);
  }
  return box;
}

// A full single-tx review block: the pretty decoded tree + a "Show raw data" toggle (named-arg JSON, with
// addresses + start-times annotated). Used by the Safe-propose modal and anywhere a single call is reviewed.
export function renderTxReview(tx) {
  var wrap = el('div', 'tx-review');
  wrap.appendChild(renderDecodedTx(tx));
  var details = document.createElement('details'); details.className = 'tx-rawdata';
  var sm = document.createElement('summary'); sm.textContent = 'Show raw data'; details.appendChild(sm);
  var pre = el('pre', 'create-payload');
  pre.textContent = annotateTimestamps(annotateAddresses(txRawJson(tx)));
  details.appendChild(pre);
  wrap.appendChild(details);
  return wrap;
}

// The raw view: decoded function + NAMED args as indented JSON (tuples expanded), falling back to the raw
// call fields when the ABI can't decode it.
function txRawJson(tx) {
  var obj = null;
  var cd = txCalldata(tx);
  try {
    var name = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : ((tx.address || tx.to) ? contractNameByAddress(tx.address || tx.to) : null);
    var abi = name ? getABI(name) : null;
    if (cd && cd !== '0x' && abi) {
      var dec = decodeFunctionData({ abi: abi, data: cd });
      var frag = abi.filter(function (e) { return e.type === 'function' && e.name === dec.functionName; })[0];
      var inputs = (frag && frag.inputs) || [];
      var named = {};
      (dec.args || []).forEach(function (v, i) { named[(inputs[i] && inputs[i].name) || ('arg' + i)] = v; });
      obj = { contract: name, address: tx.address || tx.to, chain: tx.chain, function: dec.functionName, args: named, calldata: cd };
    }
  } catch (_) {}
  if (!obj) obj = { contract: tx.contract, address: tx.address || tx.to, chain: tx.chain, function: txFnName(tx), args: (tx.args || tx.rawArgs), calldata: cd, value: tx.value };
  return formatPayloadJson(obj);
}
function renderDecodedSummary(payload) {
  var list = Array.isArray(payload.transactions) ? payload.transactions : (Array.isArray(payload.chains) ? payload.chains : null);
  var wrap = el('div', 'tx-decoded-list');
  if (payload.action) { var a = el('div', 'tx-decoded-action'); a.textContent = payload.action; wrap.appendChild(a); }
  if (list) { list.forEach(function (t) { wrap.appendChild(renderDecodedTx(t)); }); return wrap; }
  // Single-tx payload (executeTransaction): function + args, or calldata.
  if (payload.function || payload.calldata || payload.address) { wrap.appendChild(renderDecodedTx(payload)); return wrap; }
  return null;
}

// Shared confirm-dialog BODY (safety note, optional description, decoded summary first, exact raw payload
// behind a "Show raw data" toggle, audit-prompt link). Both confirmTransactionModal and discover's
// openTxConfirm append this into their own modal chrome, so every confirm dialog reads identically.
export function renderConfirmBody(content, payload, opts) {
  opts = opts || {};
  var note = el('div', 'tx-confirm-note');
  note.textContent = opts.note || 'This is the exact transaction that will be sent to your wallet. Review it before signing.';
  content.appendChild(note);
  if (opts.description) { var desc = el('div', 'tx-confirm-desc'); desc.textContent = opts.description; content.appendChild(desc); }
  var decoded = renderDecodedSummary(payload);
  if (decoded) content.appendChild(decoded);
  var pre = el('pre', 'create-payload');
  pre.textContent = annotateTimestamps(annotateAddresses(formatPayloadJson(payload)));
  if (decoded) {
    var details = document.createElement('details'); details.className = 'tx-rawdata';
    var sm = document.createElement('summary'); sm.textContent = 'Show raw data'; details.appendChild(sm);
    details.appendChild(pre); content.appendChild(details);
  } else {
    content.appendChild(pre);
  }
  appendAuditPromptLink(content, payload);
}

export function confirmTransactionModal(payload, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var overlay = el('div', 'modal-overlay');
    var dialog = el('div', 'modal-dialog');
    var head = el('div', 'modal-head');
    var h = el('div', 'modal-title'); h.textContent = opts.title || 'Confirm transaction'; head.appendChild(h);
    var x = document.createElement('button'); x.className = 'modal-close'; x.textContent = '✕'; head.appendChild(x);
    dialog.appendChild(head);
    var content = el('div', 'pay-confirm');
    renderConfirmBody(content, payload, opts); // safety note + decoded summary + raw-in-details + audit link
    var foot = el('div', 'create-modal-foot');
    var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
    var confirm = el('button', 'create-btn primary'); confirm.textContent = opts.confirmText || 'Confirm & send';
    foot.appendChild(cancel); foot.appendChild(confirm); content.appendChild(foot);
    // Post-confirm progress shows HERE, inside the modal — the modal stays open after "Confirm" so callers
    // don't have to render tx status next to a button. Hidden until the tx is in flight.
    var statusEl = el('div', 'tx-confirm-status'); statusEl.style.display = 'none'; content.appendChild(statusEl);
    dialog.appendChild(content); overlay.appendChild(dialog);
    // Legacy callers await a boolean and expect the modal to close on confirm. `keepOpenForProgress`
    // (executeTransaction only) opts into the richer behavior: stay open, resolve { ok, showStatus, close }.
    var keepOpen = !!opts.keepOpenForProgress;
    var cancelResult = keepOpen ? { ok: false } : false;
    var resolved = false, inFlight = false;
    function finish(result) { if (resolved) return; resolved = true; resolve(result); }
    function teardown() { document.removeEventListener('keydown', onKey); if (overlay.parentNode) overlay.remove(); }
    function close(result) { finish(result); teardown(); }
    function showStatus(m, kind) {
      statusEl.style.display = '';
      statusEl.className = 'tx-confirm-status ' + (kind === 'error' ? 'error' : kind === 'success' ? 'success' : 'pending');
      statusEl.textContent = m;
    }
    function onKey(e) { if (e.key === 'Escape' && !inFlight) close(cancelResult); }
    x.addEventListener('click', function () { if (!inFlight) close(cancelResult); });
    cancel.addEventListener('click', function () { if (!inFlight) close(cancelResult); });
    confirm.addEventListener('click', function () {
      if (keepOpen) {
        // Hand control to the caller: keep the modal open, disable the buttons, and let it drive
        // showStatus()/close() as the tx progresses. Resolve now so the caller can start.
        inFlight = true; confirm.disabled = true; cancel.disabled = true;
        finish({ ok: true, showStatus: showStatus, close: teardown });
      } else {
        close(true);
      }
    });
    overlay.addEventListener('click', function (e) { if (e.target === overlay && !inFlight) close(cancelResult); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  });
}

export function executeTransaction(opts) {
  // opts: { chainId, address, abi, functionName, args, value, tokenAddr, spenderAddr, approvalAmount, onStatus, onSuccess, onError, skipConfirm, label }
  var wallet = getWalletClient();
  if (!wallet) { opts.onError('Connect wallet to transact'); return; }
  var account = getAccount();
  if (!account) { opts.onError('Connect wallet to transact'); return; }

  // Status/result callbacks. When the confirm modal is shown (not skipConfirm), these get wrapped so tx
  // progress renders INSIDE the modal (which stays open after Confirm) — callers no longer show it elsewhere.
  var cbs = { onStatus: opts.onStatus || function () {}, onSuccess: opts.onSuccess || function () {}, onError: opts.onError || function () {} };

  // Build the review payload and require explicit confirmation, unless the caller already showed its own.
  var confirmStep;
  if (opts.skipConfirm) {
    confirmStep = Promise.resolve({ ok: true });
  } else {
    var cname = opts.contractName || resolveContractName(opts.address, opts.chainId);
    var payload = {
      action: opts.label || opts.functionName,
      chain: (CHAINS[opts.chainId] && CHAINS[opts.chainId].name) || ('chain ' + opts.chainId),
      contract: cname || opts.address,
      // Keep the raw target address visible even when we resolved a name (nothing is hidden).
      address: cname ? opts.address : undefined,
      function: opts.functionName,
      abi: abiSignature(opts.abi, opts.functionName),
      args: opts.args,
      value: (opts.value || 0n),
    };
    if (opts.tokenAddr && opts.spenderAddr && opts.approvalAmount) {
      payload.erc20Approval = { token: opts.tokenAddr, spender: opts.spenderAddr, amount: opts.approvalAmount };
    }
    confirmStep = confirmTransactionModal(payload, { title: opts.confirmTitle || 'Confirm transaction', confirmText: opts.confirmText, note: opts.confirmNote, description: opts.confirmDescription, keepOpenForProgress: true });
  }

  confirmStep.then(function (r) {
    if (!r || !r.ok) { (opts.onError || function () {})('Transaction cancelled'); return; }
    // Modal stayed open → mirror status into it and close it on success; still call the caller's handlers.
    if (r.showStatus) {
      var base = cbs;
      cbs = {
        onStatus: function (m, k, meta) { r.showStatus(m, k); base.onStatus(m, k, meta); },
        onSuccess: function (m, meta) { if (r.close) r.close(); base.onSuccess(m, meta); },
        onError: function (m, meta) { r.showStatus(m, 'error'); base.onError(m, meta); },
      };
    }
    sendNow();
  });

  function sendNow() {
  cbs.onStatus('Checking wallet network...', 'pending');

  wallet.getChainId().then(function(walletChainId) {
    if (walletChainId !== opts.chainId) {
      cbs.onStatus('Switching to ' + (CHAINS[opts.chainId] ? CHAINS[opts.chainId].name : 'chain ' + opts.chainId) + '...', 'pending');
      return switchChain(opts.chainId);
    }
  }).then(function() {
    if (opts.tokenAddr && opts.spenderAddr && opts.approvalAmount) {
      return checkAndApprove(opts.tokenAddr, opts.spenderAddr, opts.approvalAmount, opts.chainId, cbs.onStatus);
    }
  }).then(function() {
    cbs.onStatus('Awaiting wallet confirmation...', 'pending');
    return wallet.writeContract({
      account: account,
      chain: CHAINS[opts.chainId],
      address: opts.address,
      abi: opts.abi,
      functionName: opts.functionName,
      args: opts.args,
      value: opts.value || 0n,
    });
  }).then(function(hash) {
    // Submitted to the mempool — now waiting to be included onchain. Keep a live pending state up
    // the whole time (waitForTransactionReceipt can take a while).
    cbs.onStatus('Confirming onchain | ' + truncAddr(hash), 'pending', { phase: 'submitted', hash: hash, chainId: opts.chainId });
    var pub = createPublicClientForChain(opts.chainId);
    return pub.waitForTransactionReceipt({ hash: hash });
  }).then(function(receipt) {
    cbs.onSuccess('Confirmed in block ' + receipt.blockNumber + ' \u00b7 TX: ' + truncAddr(receipt.transactionHash), { phase: 'confirmed', hash: receipt.transactionHash, chainId: opts.chainId, blockNumber: receipt.blockNumber });
  }).catch(function(err) {
    var msg = err.shortMessage || err.message || 'Unknown error';
    var full = ((err.message || '') + ' ' + (err.details || '') + ' ' + (err.cause && (err.cause.message || err.cause.shortMessage) || '')).toLowerCase();
    var chainName = CHAINS[opts.chainId] ? CHAINS[opts.chainId].name : ('chain ' + opts.chainId);
    if (msg.indexOf('rejected') !== -1 || msg.indexOf('User rejected') !== -1 || /user rejected|denied transaction/i.test(full)) {
      cbs.onError('Transaction rejected by wallet');
    } else if (/insufficient funds|exceeds the balance|gas \* price|gas required exceeds/.test(full)) {
      // Most common real failure for destination-chain claims and any tx on a chain the wallet isn't funded on.
      cbs.onError('Not enough ' + chainName + ' ETH to cover gas. Fund your wallet on ' + chainName + ', then try again.');
    } else {
      cbs.onError(msg.length > 150 ? msg.slice(0, 150) + '...' : msg);
    }
  });
  }
}

function checkAndApprove(tokenAddr, spender, amount, chainId, onStatus) {
  var pub = createPublicClientForChain(chainId);
  var owner = getAccount();
  if (!pub || !owner) return Promise.resolve();
  // Native ETH (and the zero address) have no ERC-20 contract — no allowance/approval step. Reading
  // `allowance` on the native pseudo-address reverts with "returned no data (0x)".
  if (!tokenAddr || tokenAddr.toLowerCase() === NATIVE_TOKEN.toLowerCase() || tokenAddr === ZERO_ADDRESS) return Promise.resolve();

  return pub.readContract({
    address: tokenAddr,
    abi: erc20AllowanceAbi,
    functionName: 'allowance',
    args: [owner, spender],
  }).then(function(allowance) {
    if (BigInt(allowance) >= BigInt(amount)) return;
    onStatus('Approving token spend...', 'pending');
    var wallet = getWalletClient();
    return wallet.writeContract({
      account: owner,
      chain: CHAINS[chainId],
      address: tokenAddr,
      abi: erc20ApproveAbi,
      functionName: 'approve',
      args: [spender, amount],
    }).then(function(hash) {
      return pub.waitForTransactionReceipt({ hash: hash });
    });
  });
}

// --- Read contract helper ---

export function executeRead(opts) {
  // opts: { chainId, address, abi, functionName, args }
  var client = createPublicClientForChain(opts.chainId);
  if (!client) return Promise.reject(new Error('No client for chain ' + opts.chainId));
  return client.readContract({
    address: opts.address,
    abi: opts.abi,
    functionName: opts.functionName,
    args: opts.args || [],
  });
}

// --- Pre-flight simulation (eth_call) ---
// Dry-runs a state-changing call without sending a transaction, so encoding/logic reverts surface
// BEFORE the user signs. Resolves on success; rejects with the decoded revert reason on failure.
// The caller is funded via a balance state-override so a low/zero balance never masks a logic check
// (the wallet enforces real funding at send time; multichain users fund once via the relayer). If the
// chain's RPC rejects state overrides, it retries without one.
// opts: { chainId, address, abi, functionName, args, value, account }
export function simulateTransaction(opts) {
  var client = createPublicClientForChain(opts.chainId);
  if (!client) return Promise.reject(new Error('No client for chain ' + opts.chainId));
  var account = opts.account || getAccount();
  var base = {
    account: account, address: opts.address, abi: opts.abi,
    functionName: opts.functionName, args: opts.args || [], value: opts.value || 0n,
  };
  var fundOverride = account ? [{ address: account, balance: (opts.value || 0n) + 1000000000000000000n }] : undefined;
  function run(withOverride) {
    var req = withOverride && fundOverride ? Object.assign({ stateOverride: fundOverride }, base) : base;
    return client.simulateContract(req);
  }
  return run(true).catch(function (err) {
    var msg = (err && (err.shortMessage || err.message) || '').toLowerCase();
    // RPC doesn't support eth_call state overrides → retry without; otherwise surface the revert.
    if (fundOverride && /state override|stateoverride|not support|invalid params|unknown field|method/.test(msg)) {
      return run(false);
    }
    throw err;
  }).catch(function (err) {
    var reason = err && (err.shortMessage || err.message) || 'reverted';
    var e = new Error(reason); e.cause = err; throw e;
  });
}

// --- Decimals lookup ---

export function lookupDecimals(chainId, tokenAddr, callback) {
  var client = createPublicClientForChain(chainId);
  if (!client) { callback(null); return; }
  client.readContract({
    address: tokenAddr,
    abi: erc20DecimalsAbi,
    functionName: 'decimals',
    args: [],
  }).then(function(result) {
    callback(Number(result));
  }).catch(function() {
    callback(null);
  });
}

// --- Component wrapper factory ---

// Each component → the code file + contract function + a plain-English account of what it does and the
// gotchas that make it correct and safe, so the "copy prompt" link tells an LLM exactly what to build.
// EXPORTED so discover.js's project-page cards/modals reuse the same descriptions.
export var COMPONENT_SPECS = {
  pay: { file: 'pay-component.js (buildPayArgs)', fn: 'JBMultiTerminal.pay(uint256 projectId, address token, uint256 amount, address beneficiary, uint256 minReturnedTokens, string memo, bytes metadata) payable returns (uint256 beneficiaryTokenCount)', desc: "Pays a Juicebox project through its terminal (the explorer resolves the best of JBRouterTerminalRegistry vs the direct JBMultiTerminal by comparing previewed token output) and mints project tokens to the beneficiary at the ruleset weight, excluding the reserved % that goes to splits. It calls pay(projectId, token, amount, beneficiary, minReturnedTokens, memo, metadata) in exactly that tuple order; amount is in the payment token's own decimals, while minReturnedTokens and the returned beneficiaryTokenCount are 18-decimal project-token units measured as the beneficiary's balance delta (so reserved tokens are excluded from the floor check). For native ETH, pass the NATIVE_TOKEN sentinel as token and set msg.value=amount — the contract ignores the amount arg and uses msg.value; for ERC-20s the payer must first approve the resolved terminal/router address (not always JBMultiTerminal) for amount. minReturnedTokens is the only sandwich protection and the builder hardcodes it to 99% of the previewed output (1% slippage), falling back to 0 (no protection) whenever no priced preview exists, which is dangerous because a buyback/data hook can reroute the payment through a Uniswap swap — a faithful, safe rebuild should require a real floor rather than shipping 0. pay is permissionless (anyone can pay any project), the component sends memo as-is and empty 0x metadata (no hookdata), and any currency conversion (base currency vs paid token) is applied inside the ruleset/data hook, not in the pay args." },
  cashout: { file: 'cashout-component.js (buildCashOutArgs)', fn: 'JBMultiTerminal.cashOutTokensOf(address holder, uint256 projectId, uint256 cashOutCount, address tokenToReclaim, uint256 minTokensReclaimed, address payable beneficiary, bytes metadata) returns (uint256 reclaimAmount)', desc: "Burns a holder's project tokens to reclaim a pro-rata share of the project's terminal surplus (terminal balance minus the unmet payout limit) along the ruleset's bonding curve. It calls cashOutTokensOf with args in this exact order: holder (address), projectId (uint256), cashOutCount (uint256, the project tokens to burn as 18-decimal fixed point), tokenToReclaim (address of the terminal token), minTokensReclaimed (uint256 in the TERMINAL token's accounting-context decimals — e.g. 6 for USDC, not 18), beneficiary (address that receives the reclaimed terminal tokens), and metadata (the component hardcodes '0x'). The reclaim is computed from cashOutTaxRate and cashOutCount/totalSupply, then a single 2.5% protocol fee (STANDARD_FEE/MAX_FEE = 25/1000) is subtracted only when cashOutTaxRate != 0 and the beneficiary is not a feeless address (there is no separate revnet fee here); for zero-tax cash-outs the fee applies only up to feeFreeSurplus. To set the slippage floor, read previewCashOutFrom (which runs the data hook and returns the reclaim BEFORE the protocol fee), take 95% of its reclaimAmount, and pass that as minTokensReclaimed — the contract reverts via _checkMin if the realized reclaim is below it; on preview failure (e.g. an active revnet 7-day cash-out delay) fall back to 0n so the tx stays submittable with no floor. Access is gated by _requirePermissionFrom(holder, CASH_OUT_TOKENS). If the ruleset's data hook supplies cash-out hookSpecifications (e.g. a 721 redemption hook), those are fulfilled in the same call and are also fee-eligible, so a faithful rebuild must account for hook-driven reclaim paths, not just the plain token-for-surplus path." },
  payouts: { file: 'payouts-component.js (buildSendPayoutsArgs)', fn: 'JBMultiTerminal.sendPayoutsOf(uint256 projectId, address token, uint256 amount, uint256 currency, uint256 minTokensPaidOut) returns (uint256 amountPaidOut)', desc: "Distributes a project's terminal balance to its current ruleset's payout splits, with any leftover (splits under 100%) going to the project owner and any wildcard/empty split paying msg.sender; calling is permissionless unless the ruleset sets ownerMustSendPayouts, which then requires the SEND_PAYOUTS permission. Pass exactly [projectId, token, amount, currency, minTokensPaidOut] — all five must be uint256/address or the selector breaks (declaring currency as uint32 reverts every tx). amount and minTokensPaidOut are fixed-point in the terminal token's accounting-context decimals (18 for native/ETH, 6 for USDC), and currency is a JBCurrencyIds id (ETH=1 / USD=2) that must match one of the ruleset's payout-limit currencies or the call pays nothing (returns 0, no revert). amount auto-caps to the remaining payout limit rather than reverting when over, but still reverts if the capped amount exceeds the terminal balance; a fully-used limit or a cross-currency conversion that rounds to zero is a silent no-op. The component hardcodes minTokensPaidOut=0 (no floor) — for cross-currency limits a safe rebuild should let the user set a non-zero minTokensPaidOut, checked against the gross (pre-fee) amount. A 2.5% protocol fee (25/1000) is taken in the terminal token on payouts leaving the Juicebox ecosystem (feeless addresses exempt; can be held if holdFees is set)." },
  mint: { file: 'mint-component.js (buildMintArgs)', fn: 'JBController.mintTokensOf(uint256 projectId, uint256 tokenCount, address beneficiary, string memo, bool useReservedPercent) returns (uint256 beneficiaryTokenCount)', desc: "Mints new project tokens directly to a beneficiary with no payment, by calling mintTokensOf(projectId, tokenCount, beneficiary, memo, useReservedPercent) on the project's chain-specific controller (nonpayable). tokenCount is a fixed-point integer with 18 decimals and is the TOTAL minted; it must be non-zero or the call reverts. The useReservedPercent flag (an 'Apply reserved percent' checkbox in the UI) controls whether the ruleset's reservedPercent is applied: when true the beneficiary gets tokenCount minus the reserved share and the reserved portion accrues to the project's pending reserved balance (released later via sendReservedTokensToSplitsOf); when false the beneficiary receives the full tokenCount. Minting is allowed for the project owner, an operator with MINT_TOKENS permission, the project's terminals, or its data hook — but for the owner/operator path used by this component the current ruleset must have allowOwnerMinting=true (otherwise it reverts). There is no slippage floor or msg.value; preserve the exact arg order, and note the beneficiary receives ERC-20 tokens or internal credits depending on whether the project has deployed an ERC-20." },
  burn: { file: 'burn-component.js (buildBurnArgs)', fn: 'JBController.burnTokensOf(address holder, uint256 projectId, uint256 tokenCount, string memo)', desc: "Burns a holder's project tokens (and/or unclaimed internal credits) via burnTokensOf, permanently removing them from the project's token supply on the selected chain. Args are the tuple [holder (address), projectId (uint256), tokenCount (uint256), memo (string)], nonpayable, no return; tokenCount is an 18-decimal fixed-point amount (the UI parses with parseAmount(amount, 18)). Access is _requirePermissionAllowingOverrideFrom on the holder with BURN_TOKENS, with an override for project terminals: the holder can always burn their own tokens, an operator needs the holder's BURN_TOKENS grant, and terminals are auto-allowed — there is no ERC-20 approval involved (the component burns from the connected wallet, so no grant is needed). Burns consume internal credits before deployed ERC-20, and the call reverts on tokenCount==0 (JBController_ZeroTokensToBurn) or when it exceeds the holder's combined credit+ERC-20 balance. There is no fee, no slippage floor, and no currency id — and unlike cash out, burning returns no surplus/ETH; it simply destroys tokens, raising the cash-out value for remaining holders." },
  'deploy-erc20': { file: 'deploy-erc20-component.js (buildDeployErc20Args)', fn: 'JBController.deployERC20For(uint256 projectId, string name, string symbol, bytes32 salt) returns (address token)', desc: "Deploys a project's claimable ERC-20 token via deployERC20For(projectId, name, symbol, salt), which delegates to JBTokens; the builder passes [BigInt(projectId), name, symbol, salt]. The caller does not choose decimals or currency — the token is a fixed JBERC20 clone (18 decimals, with ERC20Votes governance and ERC20Permit). This is a one-time action per project: it reverts if the project already has a token (JBTokens_ProjectAlreadyHasToken) and on an empty name or symbol (the component trims both client-side). Access is gated to the project owner or an operator with the DEPLOY_ERC20 permission; nonpayable, no fee. Note this component hardcodes salt = bytes32(0), which takes the NON-deterministic Clones.clone (CREATE) path, so the deployed address is sequence-dependent and will generally DIFFER across chains; cross-chain-identical addresses require a non-zero salt AND the same caller address per chain (the contract re-hashes the salt with the caller and controller addresses). Before deployment, holder balances live as internal credits in JBTokens; deploying does not auto-migrate them — holders must separately claim credits into the new ERC-20." },
  reserved: { file: 'reserved-component.js (buildSendReservedArgs)', fn: 'JBController.sendReservedTokensToSplitsOf(uint256 projectId)', desc: "Calls sendReservedTokensToSplitsOf(projectId), which mints the project's entire accrued pending reserved-token balance and distributes it to the reserved-token split recipients of the project's currently-active ruleset, sending any leftover (if the splits sum to less than 100%) to the project owner. The only argument is projectId (uint256) — there is no amount, currency id, slippage, or min-floor, because the amount is fixed by the contract as the full pendingReservedTokenBalanceOf[projectId] (18-decimal project-token base units), so do not add an amount input. The call is permissionless (anyone may trigger it) and takes no protocol fee. It reverts with JBController_NoReservedTokens when nothing is pending, so read pendingReservedTokenBalanceOf first and disable execute when it is zero. It flushes the whole balance (resetting pending to 0) — all-or-nothing, not partial — and split recipients may be split hooks (external calls). This does not change the bonding-curve/cash-out denominator since pending reserved tokens already count toward total supply, so it does not dilute cash-out value." },
  permissions: { file: 'permissions-component.js (buildSetPermissionsArgs)', fn: 'JBPermissions.setPermissionsFor(address account, (address operator, uint64 projectId, uint8[] permissionIds))', desc: "Builds setPermissionsFor(account, (operator, projectId, permissionIds)) to grant or revoke an operator's permissions for one project. The call OVERWRITES the operator's entire packed uint256 bitmap for that (operator, account, projectId) slot, so the permissionIds array must include every id you want to keep — omitted ids are revoked. permissionIds is a uint8[] of ids 0–255 (e.g. 1=ROOT, which implicitly grants all permissions for the scoped project); id 0 is reserved and reverts (JBPermissions_NoZeroPermission), and projectId is a uint64 where 0 is a wildcard granting access across all of the account's projects — use with care. Encoding order matters: the first top-level arg is the `account` whose permissions are set, and operator/projectId/permissionIds are the fields of the second tuple struct in that exact order. Access control: only the account itself (msg.sender == account) may set permissions freely; a ROOT operator can set on the account's behalf but CANNOT grant ROOT and CANNOT target wildcard projectId 0. There is no payment, currency, or slippage; the call is ERC2771-relayable, so the authorizing identity is _msgSender() (the meta-tx signer through a trusted forwarder), not necessarily tx.origin." },
  launch: { file: 'create-flow.js (buildLaunchArgs) + launch-component.js', fn: 'JBController.launchProjectFor(address owner, string projectUri, JBRulesetConfig[] rulesetConfigurations, JBTerminalConfig[] terminalConfigurations, string memo) payable returns (uint256 projectId)', desc: "Launches a Juicebox project in one transaction via launchProjectFor(owner, projectUri, rulesetConfigurations[], terminalConfigurations[], memo): it mints the project ERC-721 to `owner`, queues the initial rulesets, configures terminals + fund-access limits, and registers the project's controller in JBDirectory. This call is PERMISSIONLESS — anyone can launch on behalf of any owner, so a successful launch is not proof of owner consent (the caller pays the fee; the NFT goes to `owner`). The standalone controller path must send msg.value exactly equal to JBProjects.creationFee() or it reverts; there is no slippage or min-floor. Encoding gotchas: payoutLimits/surplusAllowances are (uint224 amount, uint32 currency) where amount is in the token's own decimals and currency is the token address's lower 32 bits (ETH=1/USD=2 in the single-token path), an EMPTY fundAccessLimitGroups means ZERO payouts (use uint224.max for unlimited), split shares are out of 1e9 and a group reverts if it exceeds 1e9, weight is 18-decimal fixed-point uint112 where 0 = no issuance and 1 = inherit the previous decayed weight, and reservedPercent/cashOutTaxRate/weightCutPercent must be 0–100% (cashOutTaxRate 100% disables cash-outs). Path selection is mutually exclusive: single-chain-no-store uses JBController directly, single-chain-with-store uses JB721TiersHookProjectDeployer, and any multichain uses JBOmnichainDeployer with a sucker config (distinct ABI/arg tuple each), where omnichain launches need the same CREATE2 address on every chain (salt derived from the default owner) and a shared deploy-time start." },
  'queue-ruleset': { file: 'queue-ruleset-component.js (buildQueueRulesetsArgs)', fn: 'JBController.queueRulesetsOf(uint256 projectId, JBRulesetConfig[] rulesetConfigurations, string memo) returns (uint256 rulesetId)', desc: "Queues one or more new rulesets for an existing project via queueRulesetsOf(projectId, JBRulesetConfig[], memo); queued rulesets take effect only after the current ruleset's duration ends (subject to its approval hook, which can delay or reject the change), and multiple configs queue sequentially. Caller must be the project owner or hold the QUEUE_RULESETS permission, the array must be non-empty, and a ruleset with a duration auto-cycles so do not queue duplicates. Encoding units differ per field and must be exact: weight is 18-decimal fixed point (use parseEther); weightCutPercent is out of 1_000_000_000 (percent*10_000_000); metadata.reservedPercent and metadata.cashOutTaxRate are out of 10_000 (percent*100, each reverts if over 10_000); split percents are out of SPLITS_TOTAL_PERCENT = 1_000_000_000; baseCurrency is a currency id (1 = native/ETH), not an address. The JBSplit tuple order is load-bearing — {percent uint32, projectId uint64, beneficiary address, preferAddToBalance bool, lockedUntil uint48, hook address} — as are the ruleset-metadata struct order and the payoutLimits {amount uint224, currency uint32} tuples; any reorder changes the selector and reverts. There is no protocol fee and no slippage/min-out on this call." },
  loan: { file: 'discover.js (buildBorrowArgs / buildRepayArgs, doBorrow)', fn: 'REVLoans.borrowFrom(uint256 revnetId, address token, uint256 minBorrowAmount, uint256 collateralCount, address payable beneficiary, uint256 prepaidFeePercent, address holder) / REVLoans.repayLoan(uint256 loanId, uint256 maxRepayBorrowAmount, uint256 collateralCountToReturn, address payable beneficiary, JBSingleAllowance allowance) payable', desc: "Borrows ETH against project tokens as collateral via REVLoans (revnets only), or repays an open loan to reclaim that collateral; in this UI it disburses only in the revnet's native/accounting token and only repays native loans. borrowFrom takes (revnetId, token, minBorrowAmount, collateralCount, beneficiary, prepaidFeePercent, holder) in that exact order — collateralCount is the project token amount (18 dec) to post, and the UI sets minBorrowAmount to 0 (no slippage floor, because its borrowable preview is base-currency/18-dec and cannot be safely converted to the source token's decimals/currency; a safer rebuild reads borrowableAmountFrom in the source token's own units and floors that). Opening a loan BURNS the collateral through the controller, so it is a two-step first-time flow: REVLoans must first be granted BURN_TOKENS on the holder (a one-off setPermissionsFor tx) or borrowFrom reverts; borrowFrom itself requires OPEN_LOAN and repayLoan requires REPAY_LOAN — in both, a permissioned operator controls beneficiary and can redirect funds/collateral, so grant only to trusted operators. prepaidFeePercent (out of MAX_FEE=1000, bounded 25..500 i.e. 2.5%..50%) buys a fee-free DURATION = prepaidFeePercent/500 x 10 years rather than a fixed rate, plus a fixed 1% goes to $REV; after the prepaid window a source fee accrues per second. repayLoan is payable: the UI quotes principal + determineSourceFeeAmount and pays msg.value = principal + fee + a 2% drift buffer, sets maxRepayBorrowAmount to the same (reverts REVLoans_OverMaxRepayBorrowAmount if the computed repay exceeds it), returns full collateral (collateralCountToReturn <= loan.collateral), and native overpayment is auto-refunded. Collateral is re-minted only on repayment — an unrepaid loan past the 10-year liquidation duration loses its collateral permanently." },
  move: { file: 'discover.js (buildSuckerPrepareArgs / buildSuckerToRemoteArgs)', fn: 'JBSucker.prepare(uint256 projectTokenCount, bytes32 beneficiary, uint256 minTokensReclaimed, address token, bytes32 metadata) / JBSucker.toRemote(address token) payable', desc: "Bridges a project's tokens to the same project on another chain via its JBSucker, in two on-chain steps: prepare() on the source chain, then toRemote() to ship the bridge message. prepare(projectTokenCount, beneficiary, minTokensReclaimed, token, metadata) pulls the caller's project ERC-20 (safeTransferFrom, so the sucker must be approved and the holder must have claimed credits into the ERC-20, or it reverts), cashes it out into the project's backing/terminal token, and inserts a leaf into the outbox merkle tree; beneficiary is the destination address left-padded to bytes32 (zero reverts), and `token` is the TERMINAL/accounting token (NATIVE_TOKEN for an ETH project, USDC for a USDC project) that keys the outbox and must be mapped on both chains or it reverts. The component hardcodes minTokensReclaimed=0 (no slippage floor on the local cash-out, since the remote chain re-mints the identical projectTokenCount), and the contract reverts if projectTokenCount==0 or if either the projectTokenCount or the cashed-out terminal amount exceeds uint128 (SVM compatibility). Step two, toRemote(token), is permissionless and batched — it ships the outbox root for that token, delivering every queued move (yours and others') in one message — and requires msg.value >= the registry's toRemoteFee plus the bridge transport fee; the component discovers the exact value by simulating at increasing amounts (findToRemoteValue), and toRemote reverts on NothingToSend, an enabled emergency hatch, or a deprecated/sending-disabled sucker. Delivery is asynchronous; the beneficiary must separately claim the minted tokens on the destination chain." },
  'items-for-sale': { file: 'discover.js (buildAddItemsModal / tiersFor)', fn: 'JB721TiersHook.adjustTiers(JB721TierConfig[] tiersToAdd, uint256[] tierIdsToRemove)', desc: "Adds NFT tiers (items) to a project's 721 tiers hook so payers receive an NFT (ADJUST_721_TIERS, operator-only). Gotchas: the call targets the project's 721 HOOK address (resolve per chain), NOT JBController; tiers are SORTED BY CATEGORY not price (the store reverts InvalidCategorySortOrder if out of order); supply caps at 1e9-1, which also doubles as the 'unlimited' sentinel; per-tier reserve splits use 1e9-scaled percents and a per-chain projectId; tierIdsToRemove is the second arg." },
  'transfer-ownership': { file: 'discover.js (openTransferAuthorityModal, non-rev branch)', fn: 'JBProjects.transferFrom(address from, address to, uint256 projectId)', desc: "Transfers project ownership by moving the JBProjects ERC-721 NFT to a new owner across every chain. Gotchas: ownership IS the NFT — a plain ERC-721 transferFrom(owner, to, projectId), not a JB-specific call; it hands the new owner ALL owner-only powers and does not move funds or change rulesets; must run on each chain (the NFT exists per chain); a Safe owner can't use Relayr — propose to the Safe queue instead." },
  'transfer-operator': { file: 'discover.js (openTransferAuthorityModal, rev branch)', fn: 'REVOwner.setOperatorOf(uint256 revnetId, address operator)', desc: "Hands the revnet operator role to a new address on every chain via REVOwner (revnet-only). Gotchas: the operator is NOT the NFT owner — setOperatorOf rebinds the operator the REVOwner permission account trusts; the zero address relinquishes operator powers permanently; does not move funds or change rulesets; run on each chain (Safe → Safe queue, EOA → Relayr)." },
  'edit-project': { file: 'discover.js (openProjectEditModal / submitProjectEdit)', fn: 'JBController.setUriOf(uint256 projectId, string uri)', desc: "Updates a project's off-chain metadata (name, tagline, description, logo, socials, store categories) by pinning new JSON to IPFS and pushing the new URI on every chain (SET_PROJECT_URI, operator-only). Gotchas: only the URI is on-chain — the content lives on IPFS, so it needs a Pinata JWT to pin; the same URI is set per chain via an ERC-2771 meta-tx through Relayr (or the Safe queue); a custom-project token symbol is stashed in this metadata, not an ERC-20." },
  'token-metadata': { file: 'discover.js (openEditTokenModal / submitTokenEdit, deployed branch)', fn: 'JBController.setTokenMetadataOf(uint256 projectId, string name, string symbol)', desc: "Renames an ALREADY-DEPLOYED project ERC-20 (name + symbol) on every chain. Gotchas: only the name/symbol change — the CREATE2 clone address is identical on every chain and never moves; if no ERC-20 exists yet this is deployERC20For instead (see deploy-erc20); operator-only, run per chain." },
  'accounting-token': { file: 'discover.js (openAddAccountingTokenModal)', fn: 'JBMultiTerminal.addAccountingContextsFor(uint256 projectId, JBAccountingContext[] accountingContexts)', desc: "Registers a token the project's terminal will accept for payments (native ETH, USDC, custom). Gotchas: the JBAccountingContext.currency is uint32(uint160(token)) — token-keyed, NOT the standard currency id (ETH=1/USD=2); decimals must match the token (USDC=6); USDC is a DIFFERENT address per chain (native is the same 0x…EEEe everywhere), so per-chain token resolution matters; adding a context is effectively irreversible (danger-gated); needs a JBPrices feed if the project's base currency differs." },
  'split-groups': { file: 'discover.js (openEditSplitsModal / submitSplitsEdit)', fn: 'JBController.setSplitGroupsOf(uint256 projectId, uint256 rulesetId, JBSplitGroup[] splitGroups)', desc: "Replaces a ruleset's split groups (reserved-token recipients or payout recipients) for the current cycle, per chain. Gotchas: the call REPLACES the whole group — omitted recipients are dropped; split percents are 1e9-scaled (SPLITS_TOTAL_PERCENT = 1,000,000,000); the reserved group id differs from a payout group id (keyed by currency/token); the JBSplit tuple field order is load-bearing (wrong order changes the selector and reverts); a split can target another project, an address, or a split hook; locked splits can't be removed before lockedUntil." },
  'add-liquidity': { file: 'discover.js (buildAddLiquidityModal / lpMint)', fn: 'Uniswap V4 PositionManager.modifyLiquidities(bytes unlockData, uint256 deadline)', desc: "Seeds the project's Uniswap V4 buyback pool so payers can route through the AMM, minting a concentrated-liquidity position over a price range. Gotchas: this is a Uniswap V4 PositionManager call, NOT a Juicebox terminal — the actions are abi-encoded (MINT_POSITION, CLOSE, CLOSE, +SWEEP for native); the pair token is native ETH or the project's accounting token (USDC 6-dec) — match its decimals; the range defaults span the cash-out floor to the issuance ceiling (1e18/weight); the Permit2 → PositionManager allowance is folded into the multicall to save a tx; only chains with a V4 position+pool manager support it." },
};
var LINK_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// An LLM prompt: the code file + contract + an English account of the component's extent and gotchas, plus
// a directive to build it completely and safely. `fileHint` overrides the source file (discover.js modals
// reuse a component's spec but live in a different file).
export function componentReproPrompt(title, prefix, fileHint) {
  var s = COMPONENT_SPECS[prefix];
  var file = fileHint || (s && s.file);
  return 'Reproduce the Juicebox V6 "' + (title || prefix) + '" component from this open-source explorer.\n'
    + (s && s.fn ? 'It builds a ' + s.fn + ' transaction.\n' : '')
    + (s && s.desc ? '\nWhat it does, and the gotchas that make it correct + safe:\n' + s.desc + '\n' : '')
    + '\nReference implementation (vanilla JS, client-only, no backend): https://github.com/mejango/juicebox-v6-website'
    + (file ? ' — read src/' + file + '. Transactions are built in-browser; the README maps every action to its contract function.' : '.') + '\n'
    + 'V6 contracts (Juicebox version 6): https://github.com/Bananapus/version-6.\n'
    + 'Build it COMPLETELY — handle the loading, empty, error, multi-chain, and permission-preflight states, not just the happy path. Before trusting this summary, READ the builder function named above and its round-trip/encoding test in the reference repo: the builder is the source of truth for arg order, decimals, currency ids, and any hardcoded value. Cross-check every arg against the on-chain ABI in the V6 contracts repo and match the tuple order, integer widths, and 4-byte selector EXACTLY (a uint32-vs-uint256 swap or a reordered tuple changes the selector and reverts every tx).\n'
    + 'SAFELY: match token decimals and the currency id per the gotchas (they often differ from 18 / from the standard ETH=1/USD=2 id); validate every address; and treat any multi-step preflight as a labeled step (ERC-20 approval, a one-off setPermissionsFor grant, or claiming credits into the ERC-20 before the action). Note which calls are permissionless vs permission-gated and do not add or drop access control. For slippage: the reference often ships a 0 or fixed-percent floor that falls back to 0 when no priced preview exists — a faithful-but-safer rebuild should EXPOSE a real user-set floor and call out where the reference ships 0 rather than silently copying the unprotected default.\n'
    + 'If you might miss a gotcha, surface it.\n'
    + 'Live reference: ' + location.href;
}

// A "[copy build prompt]" text link that copies whatever buildText() returns (an LLM build prompt). buildText
// is a function so the prompt captures the CURRENT url at click time. Used by components AND by discover.js's
// project-page cards/modals/forms.
export function promptLinkButton(buildText) {
  var btn = el('button', 'comp-prompt-link');
  btn.type = 'button';
  btn.title = 'Copy an LLM prompt to build this';
  btn.textContent = '[copy build prompt]';
  btn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    var text = buildText();
    var ok = function () { btn.classList.add('comp-prompt-link--ok'); btn.textContent = '[copied]'; setTimeout(function () { btn.classList.remove('comp-prompt-link--ok'); btn.textContent = '[copy build prompt]'; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok, ok);
    else { try { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (_) {} ok(); }
  });
  return btn;
}

// Component-specific link — names the exact code file + contract function via COMPONENT_SPECS.
export function componentPromptLink(title, prefix) {
  return promptLinkButton(function () { return componentReproPrompt(title, prefix); });
}

// The prompt link wrapped in its footer row. Used by createComponentWrapper AND by discover.js's inline
// project-page cards (Pay, Cash out, …), which don't go through the wrapper but still want the affordance.
export function promptFoot(title, prefix) {
  var foot = el('div', 'comp-prompt-foot');
  foot.appendChild(componentPromptLink(title, prefix));
  return foot;
}

export function createComponentWrapper(title, prefix, state, getEmbedParams, opts) {
  var wrapper = el('div', 'component-wrapper' + ((opts && opts.wide) ? ' component-wrapper-wide' : ''));

  var body = el('div', 'component-body');
  wrapper.appendChild(body);
  // A "copy LLM prompt" link at the bottom of every component — recreate this element with your own LLM.
  wrapper.appendChild(promptFoot(title, prefix));

  // Attach metadata to the DOM element for toolbar access
  wrapper._compTitle = title;
  wrapper._compPrefix = prefix;
  wrapper._compGetEmbedParams = getEmbedParams;

  return {
    wrapper: wrapper,
    body: body,
    title: title,
    prefix: prefix,
    getEmbedParams: getEmbedParams,
    permissionNote: (opts && opts.permissionNote) || null,
  };
}

// --- Common state initialization ---

// --- Discovery + chain selection helpers ---

export function firstChainForNetwork(state) {
  var chains = getManifestChains();
  var wantTestnet = state.network === 'testnet';
  for (var i = 0; i < state.liveChains.length; i++) {
    var ch = chains[String(state.liveChains[i])];
    if (ch && !!ch.testnet === wantTestnet) return state.liveChains[i];
  }
  return null;
}

export function selectChain(state, chainId) {
  if (chainId === null) {
    chainId = firstChainForNetwork(state);
  }
  if (!chainId) return;
  state.selectedChain = chainId;
  state.tokens = getChainTokens(chainId);
  state.selectedToken = state.tokens[0] || null;
  state.decimals = state.selectedToken ? state.selectedToken.decimals : 18;
}

export function getBeneficiaryAddress(state) {
  if (state.beneficiary === 'custom') {
    var addr = state.customBeneficiary;
    if (!addr || !isAddr(addr)) return null;
    return addr;
  }
  return getAccount() || null;
}
