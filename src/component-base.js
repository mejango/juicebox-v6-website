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
  var DEFAULT = '[Copy tx audit prompt]';
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
  if (tx.calldata && tx.calldata !== '0x' && abi) {
    try { var dec = decodeFunctionData({ abi: abi, data: tx.calldata }); return shapeDecoded(abi, dec.functionName, dec.args); } catch (_) {}
  }
  if (tx.function) return shapeDecoded(abi, tx.function, tx.args || []);
  return null;
}
// Rich decode that PRESERVES structure (nested tuples/arrays) so the renderer can build a tree, not a JSON
// blob. Returns { fn, inputs:[abiInput]|null, values:[raw] } (inputs null when no ABI — caller falls back).
function decodeCallRich(tx) {
  if (!tx) return null;
  var name = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : ((tx.address || tx.to) ? contractNameByAddress(tx.address || tx.to) : null);
  var abi = null; try { if (name) abi = getABI(name); } catch (_) {}
  if (tx.calldata && tx.calldata !== '0x' && abi) {
    try {
      var dec = decodeFunctionData({ abi: abi, data: tx.calldata });
      var frag = abi.filter(function (e) { return e.type === 'function' && e.name === dec.functionName; })[0];
      return { fn: dec.functionName, inputs: (frag && frag.inputs) || [], values: Array.from(dec.args || []) };
    } catch (_) {}
  }
  if (tx.function) {
    var frag2 = abi && abi.filter(function (e) { return e.type === 'function' && e.name === tx.function; })[0];
    if (frag2) return { fn: tx.function, inputs: frag2.inputs || [], values: tx.args || [] };
    return { fn: tx.function, inputs: null, shaped: shapeDecoded(abi, tx.function, tx.args || []).args };
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
  try {
    var name = (tx.contract && !/^0x/.test(tx.contract)) ? tx.contract : ((tx.address || tx.to) ? contractNameByAddress(tx.address || tx.to) : null);
    var abi = name ? getABI(name) : null;
    if (tx.calldata && tx.calldata !== '0x' && abi) {
      var dec = decodeFunctionData({ abi: abi, data: tx.calldata });
      var frag = abi.filter(function (e) { return e.type === 'function' && e.name === dec.functionName; })[0];
      var inputs = (frag && frag.inputs) || [];
      var named = {};
      (dec.args || []).forEach(function (v, i) { named[(inputs[i] && inputs[i].name) || ('arg' + i)] = v; });
      obj = { contract: name, address: tx.address || tx.to, chain: tx.chain, function: dec.functionName, args: named, calldata: tx.calldata };
    }
  } catch (_) {}
  if (!obj) obj = { contract: tx.contract, address: tx.address || tx.to, chain: tx.chain, function: tx.function, args: tx.args, calldata: tx.calldata, value: tx.value };
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
  pay: { file: 'pay-component.js (buildPayArgs)', fn: 'JBMultiTerminal.pay', desc: 'Pays a project in a token its terminal accepts and mints project tokens to the beneficiary at the ruleset weight, minus the reserved %. Gotchas: the amount is in the paid token’s own decimals; native ETH uses the 0x…EEEe sentinel plus msg.value; if the project’s base currency differs from the paid token a JBPrices feed converts it; ALWAYS pass minReturnedTokens (slippage) or the payer can be sandwiched, especially when a buyback data hook may reroute the pay through a Uniswap swap; reserved tokens go to splits, not the payer.' },
  cashout: { file: 'cashout-component.js (buildCashOutArgs)', fn: 'JBMultiTerminal.cashOutTokensOf', desc: 'Burns project tokens to reclaim a share of the project’s surplus along the bonding curve. Gotchas: reclaim = curve(cashOutTaxRate, count/totalSupply) then minus a 2.5% protocol fee and (for revnets) a 2.5% revnet fee; compute minTokensReclaimed from previewCashOutFrom (which runs the data hook), NOT currentReclaimableSurplusOf, or the tx reverts; surplus is the terminal balance MINUS the remaining payout limit; if a 721 cash-out data hook is active, project-token cash-out reverts — token cash-out and item redemption are mutually exclusive; revnets may enforce a cash-out delay.' },
  payouts: { file: 'payouts-component.js (buildSendPayoutsArgs)', fn: 'JBMultiTerminal.sendPayoutsOf', desc: 'Distributes up to the current payout limit to the ruleset’s payout splits, leftover to the owner. Gotchas: in V6 the amount auto-caps to the remaining limit (does NOT revert when over); the currency arg is the standard currency id (uint256, ETH=1 / USD=2), not the token address; a 2.5% fee applies to payouts leaving the Juicebox ecosystem (feeless addresses exempt); a split can pay another project or a split hook.' },
  mint: { file: 'mint-component.js (buildMintArgs)', fn: 'JBController.mintTokensOf', desc: 'Mints project tokens directly to a beneficiary without a payment (owner/operator only). Gotchas: only works when the ruleset allows owner minting; the reserved rate does NOT apply to a direct mint; respects the credits-vs-ERC-20 split.' },
  burn: { file: 'burn-component.js (buildBurnArgs)', fn: 'JBController.burnTokensOf', desc: 'Burns a holder’s project tokens. Gotchas: burns internal credits before ERC-20; needs the holder’s approval/permission; this does NOT return surplus — that is cash out.' },
  'deploy-erc20': { file: 'deploy-erc20-component.js (buildDeployErc20Args)', fn: 'JBController.deployERC20For', desc: 'Deploys the project’s claimable ERC-20 (one-time). Gotchas: a deterministic CREATE2 clone, so the SAME address on every chain; before this, holders have internal credits; 18 decimals are required.' },
  reserved: { file: 'reserved-component.js (buildSendReservedArgs)', fn: 'JBController.sendReservedTokensToSplitsOf', desc: 'Mints the project’s accrued reserved tokens to its reserved splits. Gotchas: this does NOT change the bonding-curve denominator (pending reserved already counts toward total supply), so it does not dilute cash-out value; leftover goes to the owner.' },
  permissions: { file: 'permissions-component.js (buildSetPermissionsArgs)', fn: 'JBPermissions.setPermissionsFor', desc: 'Grants or revokes an operator’s permission ids on a project (or wildcard project 0 for all). Gotchas: a 256-bit packed set; ROOT (id 1) grants everything; the call REPLACES the operator’s set for that project, so include every id you want to keep.' },
  launch: { file: 'create-flow.js (buildLaunchArgs) + launch-component.js', fn: 'JBController.launchProjectFor', desc: 'Launches a project: mints the owner NFT, queues the initial rulesets, sets terminals and fund-access limits, registers it in the directory. Gotchas: an empty fundAccessLimitGroups means ZERO payouts, not unlimited (use uint224.max for unlimited); weight=1 inherits the previous decayed weight; standalone launch must send value = JBProjects.creationFee(); omnichain launches need the omnichain deployer + suckers and the same address on each chain.' },
  'queue-ruleset': { file: 'queue-ruleset-component.js (buildQueueRulesetsArgs)', fn: 'JBController.queueRulesetsOf', desc: 'Queues new rulesets that take effect after the current one ends, subject to the current ruleset’s approval hook. Gotchas: the JBSplit tuple field order is load-bearing (a wrong order changes the selector and reverts); an approval hook (edit deadline) can delay or reject the change; weight is 18-decimal; a ruleset with a duration auto-cycles, so do not queue duplicates.' },
  loan: { file: 'discover.js (buildBorrowArgs / buildRepayArgs)', fn: 'REVLoans.borrowFrom / repayLoan', desc: 'Borrows ETH/USDC against project tokens as collateral via REVLoans (revnets only), or repays to reclaim collateral. Gotchas: the borrowable amount and any min-borrow floor must be denominated in the SOURCE token’s own decimals/currency, NOT the 18-dec base-currency preview, or a USDC loan reverts; a prepaid fee buys a fixed-rate period; the loan accrues fees over time; repaying returns the collateral tokens.' },
  move: { file: 'discover.js (buildSuckerPrepareArgs / buildSuckerToRemoteArgs)', fn: 'JBSucker.prepare → toRemote', desc: 'Bridges project tokens to the same project on another chain through its JBSucker (prepare on the source, then toRemote). Gotchas: only the ERC-20 bridges — credits or a zero balance bridge nothing; the amount is capped at uint128 (Solana/SVM compatibility); the beneficiary is encoded as bytes32; the bridge fee varies by route and must be discovered or toRemote reverts; the token must be mapped on both chains.' },
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
    + 'Build it COMPLETELY — handle the loading, empty, error, and multi-chain states, not just the happy path — and SAFELY: match the token decimals and currency id exactly, set a slippage floor wherever funds move, validate every address, honor the gotchas above, and match the on-chain transaction encoding (arg order, decimals, currency, slippage) exactly. If you might miss a gotcha, surface it.\n'
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
