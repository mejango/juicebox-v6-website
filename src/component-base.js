// src/component-base.js
// Shared building blocks for all component widgets

import { getAccount, getWalletClient, createPublicClientForChain, connect, onWalletChange, switchChain, eagerConnect } from './wallet.js';
import { CHAINS, getManifestChains, getChainTokens, contractNameByAddress } from './chain.js';
import { parseAmount, formatAmount } from './encoding.js';
import { renderError } from './errors.js';
import { getAddress, meta } from './abi-registry.js';

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

export { getAccount, getWalletClient, createPublicClientForChain, connect, onWalletChange, switchChain, eagerConnect };
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

export function createProjectInput(state, onUpdate) {
  var section = el('div', 'component-section');
  var label = el('label', 'input-label');
  label.innerHTML = 'project ID <span class="type-hint">uint256</span>';
  section.appendChild(label);
  var input = el('input', 'field numeric-field');
  input.type = 'text';
  input.placeholder = '1';
  input.value = state.projectId;
  input.addEventListener('input', function() {
    state.projectId = input.value.trim();
    onUpdate();
  });
  section.appendChild(input);

  if (state.phase === 'discovering') {
    var disc = el('div', 'component-status component-discovering');
    disc.textContent = 'Searching chains...';
    section.appendChild(disc);
  }
  return section;
}

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

export function createChainSelector(state, onChainChange) {
  var chainSection = el('div', 'component-section');
  var chains = getManifestChains();

  var chainHeader = el('div', 'chain-header-row');
  var chainLabel = el('label', 'input-label');
  chainLabel.textContent = 'chain';
  chainHeader.appendChild(chainLabel);

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
    onChainChange(null); // null means "pick first for network"
  });
  chainHeader.appendChild(netSelect);
  chainSection.appendChild(chainHeader);

  var pillsRow = el('div', 'chain-pills-row');
  var isTestnet = state.network === 'testnet';
  for (var i = 0; i < state.liveChains.length; i++) {
    (function(cid) {
      var ch = chains[String(cid)];
      if (!ch) return;
      if (isTestnet !== !!ch.testnet) return;
      var pill = el('button', 'chain-pill' + (ch.testnet ? ' testnet' : '') + (state.selectedChain === cid ? ' selected' : ''));
      pill.textContent = ch.name;
      pill.addEventListener('click', function() {
        onChainChange(cid);
      });
      pillsRow.appendChild(pill);
    })(state.liveChains[i]);
  }
  chainSection.appendChild(pillsRow);
  return chainSection;
}

export function createTokenSelector(state, onChange) {
  var amtSection = el('div', 'component-section');
  var amtLabel = el('label', 'input-label');
  amtLabel.textContent = 'amount';
  amtSection.appendChild(amtLabel);

  var amtWrapper = el('div', 'amount-with-token');
  var amtInput = el('input', 'field numeric-field amount-input');
  amtInput.type = 'text';
  amtInput.placeholder = '0.1';
  amtInput.value = state.amount;
  amtInput.addEventListener('input', function() {
    state.amount = amtInput.value.trim();
    onChange();
  });
  amtWrapper.appendChild(amtInput);

  if (state.tokens.length > 0) {
    var tokenSelect = el('select', 'token-dropdown');
    for (var t = 0; t < state.tokens.length; t++) {
      var opt = document.createElement('option');
      opt.value = state.tokens[t].address;
      opt.textContent = state.tokens[t].symbol;
      if (state.selectedToken && state.selectedToken.address.toLowerCase() === state.tokens[t].address.toLowerCase()) {
        opt.selected = true;
      }
      tokenSelect.appendChild(opt);
    }
    tokenSelect.addEventListener('change', function() {
      var addr = tokenSelect.value;
      for (var ti = 0; ti < state.tokens.length; ti++) {
        if (state.tokens[ti].address === addr) {
          state.selectedToken = state.tokens[ti];
          state.decimals = state.tokens[ti].decimals || 18;
          onChange();
          break;
        }
      }
    });
    amtWrapper.appendChild(tokenSelect);
  }
  amtSection.appendChild(amtWrapper);
  return amtSection;
}

export function createAmountInput(state, onAmountChange, label) {
  var section = el('div', 'component-section');
  var lbl = el('label', 'input-label');
  lbl.textContent = label || 'amount';
  section.appendChild(lbl);
  var input = el('input', 'field numeric-field');
  input.type = 'text';
  input.placeholder = '0';
  input.value = state.amount || '';
  input.addEventListener('input', function() {
    state.amount = input.value.trim();
    onAmountChange();
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
  lines.push("I'm about to sign a blockchain transaction in the Juicebox V6 web app. Act as a careful security reviewer: independently verify the transaction, confirm it matches my intent, and only then give a go/no-go. Assume I could be the target of a scam or a spoofed UI — trust the on-chain data and source code over anything the page says.");
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
  lines.push('Verify the contract source:');
  lines.push('- Full Juicebox V6 ecosystem (all contracts): https://github.com/Bananapus/version-6');
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

// GitHub repo for a Juicebox V6 contract by name (best-effort; all are tracked in the version-6 umbrella).
function contractRepoFor(name) {
  if (!name || /^0x/i.test(name)) return null;
  if (name === 'ERC2771Forwarder') return 'OpenZeppelin ERC2771Forwarder: https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/metatx/ERC2771Forwarder.sol';
  if (/Sucker/.test(name)) return name + ' (nana-suckers): https://github.com/Bananapus/nana-suckers';
  if (/^JB721/.test(name)) return name + ' (nana-721-hook): https://github.com/Bananapus/nana-721-hook';
  if (name === 'JBOmnichainDeployer') return name + ' (nana-omnichain-deployers): https://github.com/Bananapus/nana-omnichain-deployers';
  if (name === 'JBRouterTerminalRegistry') return name + ' (nana-router-terminal): https://github.com/Bananapus/nana-router-terminal';
  if (/^REV/.test(name)) return name + ' (revnet-core): https://github.com/Bananapus/revnet-core';
  if (/^JB/.test(name)) return name + ' (nana-core): https://github.com/Bananapus/nana-core';
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
  if (!payload || Array.isArray(payload.chains)) return []; // relayr payment is a separate prompt
  var out = [];
  if (payload.chain) out.push('Network: ' + payload.chain + ' — make sure your wallet is on this network.');
  var to = payload.address || (typeof payload.contract === 'string' && /^0x/.test(payload.contract) ? payload.contract : null);
  if (to) out.push('Recipient / "To" address: ' + to + (payload.contract && !/^0x/.test(payload.contract) ? ' (' + payload.contract + ')' : '') + ' — it must match this exactly.');
  out.push('Amount / value: ' + weiToEth(payload.value || 0) + ' ETH' + ((payload.value && BigInt(payload.value) > 0n) ? '' : ' (zero — your wallet should show no ETH being sent)') + '.');
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
  if (payload && Array.isArray(payload.chains)) {
    payload.chains.forEach(function (c) { var u = explorer(c.chain, c.contract || c.to); if (u) out.push({ label: c.chain + ' target', url: u }); });
  } else if (payload) {
    var u = explorer(payload.chain, payload.contract || payload.address || payload.to);
    if (u) out.push({ label: 'Target contract', url: u });
  }
  return out;
}

// Append a subtle "[copy prompt to verify with your LLM]" link that copies buildTxAuditPrompt(payload).
export function appendAuditPromptLink(container, payload) {
  var DEFAULT = 'Copy tx audit prompt';
  var wrap = el('div', 'tx-audit-prompt');
  var link = el('a', 'tx-audit-link'); link.href = '#'; link.textContent = DEFAULT;
  link.addEventListener('click', function (e) {
    e.preventDefault();
    var text = buildTxAuditPrompt(payload);
    var p = (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(text) : Promise.reject();
    p.then(function () { link.textContent = 'Copied — paste into your LLM'; })
     .catch(function () { link.textContent = 'Copy failed — select the payload above'; });
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
    var note = el('div', 'tx-confirm-note');
    note.textContent = opts.note || 'This is the exact transaction that will be sent to your wallet. Review it before signing.';
    content.appendChild(note);
    var pre = el('pre', 'create-payload');
    pre.textContent = annotateAddresses(JSON.stringify(payload, function (k, v) { return typeof v === 'bigint' ? v.toString() : v; }, 2)
      .replace(/^(\s*)"([A-Za-z_][\w]*)":/gm, '$1$2:'));
    content.appendChild(pre);
    appendAuditPromptLink(content, payload);
    var foot = el('div', 'create-modal-foot');
    var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
    var confirm = el('button', 'create-btn primary'); confirm.textContent = opts.confirmText || 'Confirm & send';
    foot.appendChild(cancel); foot.appendChild(confirm); content.appendChild(foot);
    dialog.appendChild(content); overlay.appendChild(dialog);
    var done = false;
    function close(result) { if (done) return; done = true; document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); }
    function onKey(e) { if (e.key === 'Escape') close(false); }
    x.addEventListener('click', function () { close(false); });
    cancel.addEventListener('click', function () { close(false); });
    confirm.addEventListener('click', function () { close(true); });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
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

  // Build the review payload and require explicit confirmation, unless the caller already showed its own.
  var confirmStep;
  if (opts.skipConfirm) {
    confirmStep = Promise.resolve(true);
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
    confirmStep = confirmTransactionModal(payload, { title: opts.confirmTitle || 'Confirm transaction', confirmText: opts.confirmText });
  }

  confirmStep.then(function (ok) {
    if (!ok) { opts.onError('Transaction cancelled'); return; }
    sendNow();
  });

  function sendNow() {
  opts.onStatus('Checking wallet network...', 'pending');

  wallet.getChainId().then(function(walletChainId) {
    if (walletChainId !== opts.chainId) {
      opts.onStatus('Switching to ' + (CHAINS[opts.chainId] ? CHAINS[opts.chainId].name : 'chain ' + opts.chainId) + '...', 'pending');
      return switchChain(opts.chainId);
    }
  }).then(function() {
    if (opts.tokenAddr && opts.spenderAddr && opts.approvalAmount) {
      return checkAndApprove(opts.tokenAddr, opts.spenderAddr, opts.approvalAmount, opts.chainId, opts.onStatus);
    }
  }).then(function() {
    opts.onStatus('Awaiting wallet confirmation...', 'pending');
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
    // Submitted to the mempool — now waiting to be included onchain. Keep a live "juicing"
    // pending state up the whole time (waitForTransactionReceipt can take a while).
    opts.onStatus('Juicing… confirming onchain · ' + truncAddr(hash), 'pending', { phase: 'submitted', hash: hash, chainId: opts.chainId });
    var pub = createPublicClientForChain(opts.chainId);
    return pub.waitForTransactionReceipt({ hash: hash });
  }).then(function(receipt) {
    opts.onSuccess('Confirmed in block ' + receipt.blockNumber + ' \u00b7 TX: ' + truncAddr(receipt.transactionHash), { phase: 'confirmed', hash: receipt.transactionHash, chainId: opts.chainId, blockNumber: receipt.blockNumber });
  }).catch(function(err) {
    var msg = err.shortMessage || err.message || 'Unknown error';
    var full = ((err.message || '') + ' ' + (err.details || '') + ' ' + (err.cause && (err.cause.message || err.cause.shortMessage) || '')).toLowerCase();
    var chainName = CHAINS[opts.chainId] ? CHAINS[opts.chainId].name : ('chain ' + opts.chainId);
    if (msg.indexOf('rejected') !== -1 || msg.indexOf('User rejected') !== -1 || /user rejected|denied transaction/i.test(full)) {
      opts.onError('Transaction rejected by wallet');
    } else if (/insufficient funds|exceeds the balance|gas \* price|gas required exceeds/.test(full)) {
      // Most common real failure for destination-chain claims and any tx on a chain the wallet isn't funded on.
      opts.onError('Not enough ' + chainName + ' ETH to cover gas. Fund your wallet on ' + chainName + ', then try again.');
    } else {
      opts.onError(msg.length > 150 ? msg.slice(0, 150) + '...' : msg);
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

export function createComponentWrapper(title, prefix, state, getEmbedParams, opts) {
  var wrapper = el('div', 'component-wrapper' + ((opts && opts.wide) ? ' component-wrapper-wide' : ''));

  var body = el('div', 'component-body');
  wrapper.appendChild(body);

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

export function createBaseState(prefix) {
  var defaults = parseHashDefaults(prefix);
  return {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : null,
    tokens: [],
    selectedToken: null,
    amount: defaults.amount || '',
    decimals: 18,
    beneficiary: defaults.beneficiary ? 'custom' : 'self',
    customBeneficiary: defaults.beneficiary || '',
    network: defaults.network || 'mainnet',
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };
}

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
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return null;
    return addr;
  }
  return getAccount() || null;
}
