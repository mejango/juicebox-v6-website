// src/create-flow.js
// "Create a project" wizard — a juicebox.money/create-style multi-step flow that launches a V6
// project, feature-complete with what the contracts allow. It reuses the calldata encoder exported by
// launch-component.js (single source of truth) and routes the deploy by (chain count, NFTs):
//
//   1 chain,  no NFTs -> JBController.launchProjectFor
//   1 chain,  NFTs    -> JB721TiersHookProjectDeployer.launchProjectFor
//   >1 chain, no NFTs -> JBOmnichainDeployer.launchProjectFor (one tx per chain, shared salt + suckers)
//   >1 chain, NFTs    -> JBOmnichainDeployer.launchProjectFor (721 overload, one tx per chain)
//
// Project metadata (name/logo/description/links) is pinned to IPFS via Pinata (src/ipfs-pin.js); the
// JWT lives in localStorage only.

import { keccak256, stringToHex, parseEther } from 'viem';
import {
  el, executeTransaction, getAddress, getAccount, connect, NATIVE_TOKEN,
} from './component-base.js';
import {
  launchProjectAbi, buildRulesetConfigs, createDefaultRuleset, ZERO,
} from './launch-component.js';
import { pinFile, pinJson, hasPinata, encodeIpfsUriToBytes32 } from './ipfs-pin.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var STEPS = ['Details', 'Rulesets', 'Shop', 'Deploy'];

var CHAIN_OPTIONS = [
  { id: 1, name: 'Ethereum', testnet: false }, { id: 10, name: 'Optimism', testnet: false },
  { id: 42161, name: 'Arbitrum', testnet: false }, { id: 8453, name: 'Base', testnet: false },
  { id: 11155111, name: 'Sepolia', testnet: true }, { id: 11155420, name: 'OP Sepolia', testnet: true },
  { id: 84532, name: 'Base Sepolia', testnet: true }, { id: 421614, name: 'Arb Sepolia', testnet: true },
];

var L1_CHAINS = { 1: true, 11155111: true };

// USDC per chain (for the "Accepts" accounting-context option). 6 decimals.
var USDC_BY_CHAIN = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 10: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 42161: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  84532: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', 11155111: '0x1c7d4b196cb0c7b01d743fbc6116a902379c7238',
  11155420: '0x5fd84259d66cd46123540766be93dfe6d43130d7', 421614: '0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d',
};

var DURATION_PRESETS = [
  { label: '1 day', seconds: 86400 }, { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 }, { label: '14 days', seconds: 1209600 },
  { label: '28 days', seconds: 2419200 }, { label: '30 days', seconds: 2592000 },
  { label: '90 days', seconds: 7776000 }, { label: '365 days', seconds: 31536000 },
];

var DEADLINE_OPTIONS = [
  { key: '3hours', label: '3-hour deadline', contract: 'JBDeadline3Hours' },
  { key: '1day', label: '1-day deadline', contract: 'JBDeadline1Day' },
  { key: '3days', label: '3-day deadline', contract: 'JBDeadline3Days', def: true },
  { key: '7days', label: '7-day deadline', contract: 'JBDeadline7Days' },
  { key: 'none', label: 'No deadline', contract: null },
];

var TAG_OPTIONS = ['AI', 'Art', 'Brand', 'Business', 'Charity', 'Climate', 'Collectibles', 'Community',
  'Creator', 'DAO', 'DeFi', 'DeSci', 'Education', 'Events', 'Film', 'Fundraising', 'Games', 'Grants',
  'Hackathon', 'Media', 'Memes', 'Music', 'NFT', 'Open Source', 'Podcast', 'Public Goods', 'Research',
  'Social', 'Software', 'Sports', 'Tooling', 'Writing'];

var UINT224_MAX = (1n << 224n) - 1n;
var SPLITS_TOTAL = 1000000000; // 1e9

// ---------------------------------------------------------------------------
// ABI building blocks (shared struct components)
// ---------------------------------------------------------------------------

var SPLIT_COMPONENTS = [
  { name: 'preferAddToBalance', type: 'bool' },
  { name: 'percent', type: 'uint32' },
  { name: 'projectId', type: 'uint64' },
  { name: 'beneficiary', type: 'address' },
  { name: 'lockedUntil', type: 'uint48' },
  { name: 'hook', type: 'address' },
];
var SPLIT_GROUP_COMPONENTS = [
  { name: 'groupId', type: 'uint256' },
  { name: 'splits', type: 'tuple[]', components: SPLIT_COMPONENTS },
];
var FUND_ACCESS_COMPONENTS = [
  { name: 'terminal', type: 'address' },
  { name: 'token', type: 'address' },
  { name: 'payoutLimits', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint224' }, { name: 'currency', type: 'uint32' }] },
  { name: 'surplusAllowances', type: 'tuple[]', components: [
    { name: 'amount', type: 'uint224' }, { name: 'currency', type: 'uint32' }] },
];
var METADATA_FULL = [
  { name: 'reservedPercent', type: 'uint16' }, { name: 'cashOutTaxRate', type: 'uint16' },
  { name: 'baseCurrency', type: 'uint32' }, { name: 'pausePay', type: 'bool' },
  { name: 'pauseCreditTransfers', type: 'bool' }, { name: 'allowOwnerMinting', type: 'bool' },
  { name: 'allowSetCustomToken', type: 'bool' }, { name: 'allowTerminalMigration', type: 'bool' },
  { name: 'allowSetTerminals', type: 'bool' }, { name: 'allowSetController', type: 'bool' },
  { name: 'allowAddAccountingContext', type: 'bool' }, { name: 'allowAddPriceFeed', type: 'bool' },
  { name: 'ownerMustSendPayouts', type: 'bool' }, { name: 'holdFees', type: 'bool' },
  { name: 'useTotalSurplusForCashOuts', type: 'bool' }, { name: 'useDataHookForPay', type: 'bool' },
  { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'dataHook', type: 'address' },
  { name: 'metadata', type: 'uint16' },
];
var METADATA_PAYHOOK = [
  { name: 'reservedPercent', type: 'uint16' }, { name: 'cashOutTaxRate', type: 'uint16' },
  { name: 'baseCurrency', type: 'uint32' }, { name: 'pausePay', type: 'bool' },
  { name: 'pauseCreditTransfers', type: 'bool' }, { name: 'allowOwnerMinting', type: 'bool' },
  { name: 'allowSetCustomToken', type: 'bool' }, { name: 'allowTerminalMigration', type: 'bool' },
  { name: 'allowSetTerminals', type: 'bool' }, { name: 'allowSetController', type: 'bool' },
  { name: 'allowAddAccountingContext', type: 'bool' }, { name: 'allowAddPriceFeed', type: 'bool' },
  { name: 'ownerMustSendPayouts', type: 'bool' }, { name: 'holdFees', type: 'bool' },
  { name: 'scopeCashOutsToLocalBalances', type: 'bool' }, { name: 'useDataHookForCashOut', type: 'bool' },
  { name: 'metadata', type: 'uint16' },
];
function rulesetConfigComponents(metaComponents) {
  return [
    { name: 'mustStartAtOrAfter', type: 'uint48' }, { name: 'duration', type: 'uint32' },
    { name: 'weight', type: 'uint112' }, { name: 'weightCutPercent', type: 'uint32' },
    { name: 'approvalHook', type: 'address' },
    { name: 'metadata', type: 'tuple', components: metaComponents },
    { name: 'splitGroups', type: 'tuple[]', components: SPLIT_GROUP_COMPONENTS },
    { name: 'fundAccessLimitGroups', type: 'tuple[]', components: FUND_ACCESS_COMPONENTS },
  ];
}
var TERMINAL_CONFIG_COMPONENTS = [
  { name: 'terminal', type: 'address' },
  { name: 'accountingContextsToAccept', type: 'tuple[]', components: [
    { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' }] },
];
// 721
var TIER_FLAGS = [
  { name: 'allowOwnerMint', type: 'bool' }, { name: 'useReserveBeneficiaryAsDefault', type: 'bool' },
  { name: 'transfersPausable', type: 'bool' }, { name: 'useVotingUnits', type: 'bool' },
  { name: 'cantBeRemoved', type: 'bool' }, { name: 'cantIncreaseDiscountPercent', type: 'bool' },
  { name: 'cantBuyWithCredits', type: 'bool' },
];
var TIER_COMPONENTS = [
  { name: 'price', type: 'uint104' }, { name: 'initialSupply', type: 'uint32' },
  { name: 'votingUnits', type: 'uint32' }, { name: 'reserveFrequency', type: 'uint16' },
  { name: 'reserveBeneficiary', type: 'address' }, { name: 'encodedIpfsUri', type: 'bytes32' },
  { name: 'category', type: 'uint24' }, { name: 'discountPercent', type: 'uint8' },
  { name: 'flags', type: 'tuple', components: TIER_FLAGS },
  { name: 'splitPercent', type: 'uint32' },
  { name: 'splits', type: 'tuple[]', components: SPLIT_COMPONENTS },
];
var HOOK_FLAGS = [
  { name: 'noNewTiersWithReserves', type: 'bool' }, { name: 'noNewTiersWithVotes', type: 'bool' },
  { name: 'noNewTiersWithOwnerMinting', type: 'bool' }, { name: 'preventOverspending', type: 'bool' },
  { name: 'issueTokensForSplits', type: 'bool' },
];
var DEPLOY_721_COMPONENTS = [
  { name: 'name', type: 'string' }, { name: 'symbol', type: 'string' }, { name: 'baseUri', type: 'string' },
  { name: 'tokenUriResolver', type: 'address' }, { name: 'contractUri', type: 'string' },
  { name: 'tiersConfig', type: 'tuple', components: [
    { name: 'tiers', type: 'tuple[]', components: TIER_COMPONENTS },
    { name: 'currency', type: 'uint32' }, { name: 'decimals', type: 'uint8' }] },
  { name: 'flags', type: 'tuple', components: HOOK_FLAGS },
];
var SUCKER_CONFIG_COMPONENTS = [
  { name: 'deployerConfigurations', type: 'tuple[]', components: [
    { name: 'deployer', type: 'address' }, { name: 'peer', type: 'bytes32' },
    { name: 'mappings', type: 'tuple[]', components: [
      { name: 'localToken', type: 'address' }, { name: 'minGas', type: 'uint32' },
      { name: 'remoteToken', type: 'bytes32' }] }] },
  { name: 'salt', type: 'bytes32' },
];

// JB721TiersHookProjectDeployer.launchProjectFor (single-chain + NFTs)
var deployer721Abi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS },
    { name: 'launchProjectConfig', type: 'tuple', components: [
      { name: 'projectUri', type: 'string' },
      { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_PAYHOOK) },
      { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
      { name: 'memo', type: 'string' }] },
    { name: 'controller', type: 'address' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }],
}];

// JBOmnichainDeployer.launchProjectFor (no-721 overload)
var omnichainAbi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'projectUri', type: 'string' },
    { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_FULL) },
    { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
    { name: 'memo', type: 'string' },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }, { name: 'suckers', type: 'address[]' }],
}];

// JBOmnichainDeployer.launchProjectFor (721 overload)
var omnichain721Abi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' }, { name: 'projectUri', type: 'string' },
    { name: 'deploy721Config', type: 'tuple', components: [
      { name: 'deployTiersHookConfig', type: 'tuple', components: DEPLOY_721_COMPONENTS },
      { name: 'useDataHookForCashOut', type: 'bool' }, { name: 'salt', type: 'bytes32' }] },
    { name: 'rulesetConfigurations', type: 'tuple[]', components: rulesetConfigComponents(METADATA_FULL) },
    { name: 'terminalConfigurations', type: 'tuple[]', components: TERMINAL_CONFIG_COMPONENTS },
    { name: 'memo', type: 'string' },
    { name: 'suckerDeploymentConfiguration', type: 'tuple', components: SUCKER_CONFIG_COMPONENTS },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }, { name: 'hook', type: 'address' }, { name: 'suckers', type: 'address[]' }],
}];

// ---------------------------------------------------------------------------
// Sucker deployer selection (per local->remote pair)
// ---------------------------------------------------------------------------

// Returns the sucker-deployer contract NAME to use on `localId` for bridging to `remoteId`.
// L1 (Ethereum/Sepolia) <-> rollup uses that rollup's native bridge deployer; rollup<->rollup uses CCIP.
function suckerDeployerName(localId, remoteId) {
  var fam = function (id) {
    if (id === 1 || id === 11155111) return 'eth';
    if (id === 10 || id === 11155420) return 'op';
    if (id === 8453 || id === 84532) return 'base';
    if (id === 42161 || id === 421614) return 'arb';
    return '';
  };
  var a = fam(localId), b = fam(remoteId);
  if (a === 'eth' || b === 'eth') {
    var rollup = a === 'eth' ? b : a;
    if (rollup === 'op') return 'JBOptimismSuckerDeployer';
    if (rollup === 'base') return 'JBBaseSuckerDeployer';
    if (rollup === 'arb') return 'JBArbitrumSuckerDeployer';
  }
  // Neither side is L1 -> CCIP. The deployed CCIP deployers are route-keyed by remote chain; resolve by
  // scanning the registry for a JBCCIPSuckerDeployer* present on the local chain (best-effort).
  return 'JBCCIPSuckerDeployer';
}

// Resolve a sucker deployer address on localId for a remote chain. Returns null if not deployable.
function suckerDeployerAddress(localId, remoteId) {
  var name = suckerDeployerName(localId, remoteId);
  var addr = getAddress(name, localId);
  if (addr) return addr;
  // CCIP fallback: try common route-suffixed names for this local chain.
  if (name === 'JBCCIPSuckerDeployer') {
    var suffixes = ['', '__ETH', '__OP', '__BASE', '__ARB', '__ETH_SEP', '__OP_SEP', '__BASE_SEP', '__ARB_SEP'];
    for (var i = 0; i < suffixes.length; i++) {
      var a = getAddress('JBCCIPSuckerDeployer' + suffixes[i], localId);
      if (a) return a;
    }
  }
  return null;
}

function suckerConfigFor(localId, otherChainIds, salt) {
  var deployerConfigurations = [];
  for (var i = 0; i < otherChainIds.length; i++) {
    var remoteId = otherChainIds[i];
    var deployer = suckerDeployerAddress(localId, remoteId);
    if (!deployer) continue; // skip unsupported pair (surfaced in status)
    deployerConfigurations.push({
      deployer: deployer,
      peer: '0x0000000000000000000000000000000000000000000000000000000000000000',
      mappings: [{
        localToken: NATIVE_TOKEN,
        minGas: 200000,
        remoteToken: '0x000000000000000000000000' + NATIVE_TOKEN.slice(2).toLowerCase(),
      }],
    });
  }
  return { deployerConfigurations: deployerConfigurations, salt: salt };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function initState() {
  return {
    step: 0,
    details: {
      name: '', tagline: '', description: '', logoUri: '', logoUploading: false,
      website: '', twitter: '', discord: '', telegram: '', tags: [],
      coverImageUri: '', payDisclosure: '', owner: '', immutable: false,
      linksOpen: false, ownerOpen: false, tagsOpen: false, customOpen: false,
    },
    accepts: ['eth'],                // accounting token(s) the project HOLDS / issues against: 'eth' and/or 'usdc'
    swapRouter: true,                // include the router terminal (any token auto-converts) — on by default
    stages: [createStage()],         // ordered rulesets queued at launch (revnet-style stages)
    nfts: [], // {name,description,priceEth,imageUri,imageUploading,limited,supply,reserveFrequency,reserveBeneficiary,externalLink}
    chainIds: [11155111],
    tos: false,
    deploying: false, statusLines: [], done: false,
  };
}

// ---------------------------------------------------------------------------
// Entry / overlay
// ---------------------------------------------------------------------------

export function openCreateFlow() {
  var state = initState();
  var pre = getAccount && getAccount();
  if (pre) state.details.owner = ''; // leave blank => connected wallet

  var overlay = el('div', 'create-overlay');
  var sheet = el('div', 'create-sheet');
  overlay.appendChild(sheet);

  function close() { document.removeEventListener('keydown', onKey); overlay.remove(); }
  function onKey(e) { if (e.key === 'Escape' && !state.deploying) close(); }
  overlay.addEventListener('mousedown', function (e) { if (e.target === overlay && !state.deploying) close(); });
  document.addEventListener('keydown', onKey);

  function render() {
    sheet.innerHTML = '';
    sheet.appendChild(renderHeader(state, close));
    var wip = el('div', 'create-wip');
    wip.textContent = 'Work in progress';
    sheet.appendChild(wip);
    sheet.appendChild(renderStepper(state, render));
    var body = el('div', 'create-step');
    body.appendChild(renderStep(state, render));
    sheet.appendChild(body);
    sheet.appendChild(renderFooter(state, render, close));
  }
  render();

  document.body.appendChild(overlay);
  return { close: close };
}

function renderHeader(state, close) {
  var head = el('div', 'create-head');
  var title = el('div', 'create-title');
  title.textContent = 'Create a project';
  head.appendChild(title);
  var x = el('button', 'create-close');
  x.textContent = '✕';
  x.title = 'Close';
  x.addEventListener('click', function () { if (!state.deploying) close(); });
  head.appendChild(x);
  return head;
}

function renderStepper(state, render) {
  var row = el('div', 'create-stepper');
  STEPS.forEach(function (label, i) {
    if (i > 0) row.appendChild(el('div', 'create-step-conn' + (i <= state.step ? ' done' : '')));
    var item = el('button', 'create-step-dot' + (i === state.step ? ' active' : (i < state.step ? ' done' : '')));
    var dot = el('span', 'create-dot');
    item.appendChild(dot);
    var t = el('span', 'create-step-label');
    t.textContent = label;
    item.appendChild(t);
    item.addEventListener('click', function () { state.step = i; render(); });
    row.appendChild(item);
  });
  return row;
}

function renderFooter(state, render, close) {
  var foot = el('div', 'create-foot');
  var back = el('button', 'create-btn ghost');
  back.textContent = '← Back';
  back.disabled = state.step === 0 || state.deploying;
  back.addEventListener('click', function () { if (state.step > 0) { state.step--; render(); } });
  foot.appendChild(back);

  if (state.step < STEPS.length - 1) {
    var next = el('button', 'create-btn');
    next.textContent = 'Next →';
    next.addEventListener('click', function () { state.step++; render(); });
    foot.appendChild(next);
  }
  return foot;
}

// ---------------------------------------------------------------------------
// Step dispatch
// ---------------------------------------------------------------------------

function renderStep(state, render) {
  switch (state.step) {
    case 0: return renderDetails(state, render);
    case 1: return renderStages(state, render);
    case 2: return renderNfts(state, render);
    case 3: return renderDeploy(state, render);
  }
  return el('div');
}

// ---- small shared field helpers (create-flow look) ----

function stepHead(title, desc) {
  var w = el('div', 'create-step-head');
  var h = el('h2', 'create-step-title');
  h.textContent = title;
  w.appendChild(h);
  if (desc) { var p = el('p', 'create-step-desc'); p.textContent = desc; w.appendChild(p); }
  return w;
}

function fieldBlock(label, optional, node) {
  // `optional` is kept in the signature for call-site clarity, but we no longer render an "(optional)"
  // suffix on field labels — optionality is shown on the collapse section titles instead.
  var b = el('div', 'create-field');
  if (label) {
    var l = el('label', 'create-label');
    l.textContent = label;
    b.appendChild(l);
  }
  b.appendChild(node);
  return b;
}

function textInput(value, placeholder, onInput) {
  var i = el('input', 'field create-input');
  i.type = 'text';
  i.placeholder = placeholder || '';
  i.value = value || '';
  i.addEventListener('input', function () { onInput(i.value); });
  return i;
}

function textArea(value, placeholder, onInput) {
  var t = el('textarea', 'field create-textarea');
  t.placeholder = placeholder || '';
  t.value = value || '';
  t.addEventListener('input', function () { onInput(t.value); });
  return t;
}

function choiceCards(options, current, onPick) {
  // options: [{key, title, sub, icon}]
  var row = el('div', 'create-choices');
  options.forEach(function (o) {
    var card = el('button', 'create-choice' + (current === o.key ? ' selected' : ''));
    var top = el('div', 'create-choice-top');
    if (o.icon) { var ic = el('span', 'create-choice-icon'); ic.textContent = o.icon; top.appendChild(ic); }
    var ti = el('span', 'create-choice-title');
    ti.textContent = o.title;
    top.appendChild(ti);
    if (o.badge) { var bd = el('span', 'create-choice-badge'); bd.textContent = o.badge; top.appendChild(bd); }
    card.appendChild(top);
    if (o.sub) { var s = el('div', 'create-choice-sub'); s.textContent = o.sub; card.appendChild(s); }
    card.addEventListener('click', function () { onPick(o.key); });
    row.appendChild(card);
  });
  return row;
}

function pctSlider(value, onChange) {
  var row = el('div', 'create-slider-row');
  var slider = el('input', 'config-slider');
  slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '0.5';
  slider.value = String(value);
  var box = el('input', 'config-slider-input');
  box.type = 'text'; box.value = String(value);
  var suf = el('span', 'config-percent-suffix'); suf.textContent = '%';
  slider.addEventListener('input', function () { box.value = slider.value; onChange(Number(slider.value)); });
  box.addEventListener('input', function () {
    var v = parseFloat(box.value);
    if (!isNaN(v) && v >= 0 && v <= 100) { slider.value = String(v); onChange(v); }
  });
  row.appendChild(slider); row.appendChild(box); row.appendChild(suf);
  return row;
}

function toggleRow(label, desc, checked, onChange) {
  var w = el('div', 'create-toggle-row');
  var lbl = el('label', 'create-toggle');
  var cb = el('input', '');
  cb.type = 'checkbox'; cb.checked = !!checked;
  cb.addEventListener('change', function () { onChange(cb.checked); });
  lbl.appendChild(cb);
  var t = el('span', 'create-toggle-label'); t.textContent = label;
  lbl.appendChild(t);
  w.appendChild(lbl);
  if (desc) { var d = el('div', 'create-hint'); d.textContent = desc; w.appendChild(d); }
  return w;
}

function infoNote(text) {
  var n = el('div', 'create-hint');
  n.textContent = text;
  return n;
}

function warnNote(text) {
  var n = el('div', 'create-note warn');
  n.textContent = text;
  return n;
}

// A single timed stage would otherwise auto-repeat forever when its cycle ends. To make it run ONCE and
// then sit safe, append a "standby" ruleset: zero issuance, no payouts/surplus, payments paused, no
// expiry (it starts at stage-1's cycle end via mustStartAtOrAfter 0). Cash-outs are preserved so holders
// can still exit. Only applied when there's exactly one stage and it has a duration.
function needsStandby(stages) {
  return stages.length === 1 && stages[0].durationSeconds > 0;
}
function stagesWithStandby(stages) {
  return needsStandby(stages) ? [stages[0], standbyStage(stages[0])] : stages;
}
function standbyStage(s1) {
  var s = createStage();
  s.durationSeconds = 0;            // never expires — sits in standby
  s.baseCurrency = s1.baseCurrency;
  s.deadline = s1.deadline;
  s.tokenMode = 'custom';           // explicit zero issuance
  s.weight = '0'; s.reservedPercent = 0; s.weightCutPercent = 0; s.allowOwnerMinting = false;
  s.cashOutEnabled = s1.cashOutEnabled; s.cashOutTaxRate = s1.cashOutTaxRate; // keep exit liquidity
  s.payoutMode = 'none';            // no payouts, no surplus allowance
  s.pausePay = true;                // paused payments
  return s;
}

// Returns the index of the first non-final stage with no duration (which would break sequencing), or -1.
function badStageIndex(state) {
  for (var i = 0; i < state.stages.length - 1; i++) {
    if (!state.stages[i].durationSeconds) return i;
  }
  return -1;
}

function collapse(state, key, label, optional, render, contentFn) {
  var w = el('div', 'create-collapse');
  var head = el('button', 'create-collapse-head');
  var lab = el('span', 'create-collapse-label');
  lab.textContent = label;
  if (optional) { var o = el('span', 'create-optional'); o.textContent = ' (Optional)'; lab.appendChild(o); }
  head.appendChild(lab);
  var caret = el('span', 'create-collapse-caret');
  caret.textContent = state[key] ? '▴' : '▾';
  head.appendChild(caret);
  head.addEventListener('click', function () { state[key] = !state[key]; render(); });
  w.appendChild(head);
  if (state[key]) { var content = contentFn(); content.style.marginTop = '10px'; w.appendChild(content); }
  return w;
}

// ---------------------------------------------------------------------------
// Step 0: Details
// ---------------------------------------------------------------------------

function renderDetails(state, render) {
  var d = state.details;
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Project Details', 'You can edit these at any time.'));

  wrap.appendChild(fieldBlock('Name', false, textInput(d.name, 'My project', function (v) { d.name = v; })));
  wrap.appendChild(fieldBlock('Tagline', true, (function () {
    var n = textInput(d.tagline, 'A brief one-sentence summary of your project.', function (v) { d.tagline = v; });
    return n;
  })()));
  wrap.appendChild(fieldBlock('Description', true, textArea(d.description, 'What is your project about?', function (v) { d.description = v; })));

  // Logo
  wrap.appendChild(fieldBlock('Logo', true, renderImagePicker(d.logoUri, d.logoUploading, function (uri, busy) {
    d.logoUri = uri; d.logoUploading = busy; render();
  })));

  // Accounting token — what the project HOLDS in its treasury. The router terminal (any-token
  // auto-convert) is always part of the tx and toggled via an inline enable/disable in the description.
  wrap.appendChild(fieldBlock('Accounting', false, (function () {
    var w = el('div', '');
    w.appendChild(choiceCardsInline([{ key: 'eth', label: 'ETH' }, { key: 'usdc', label: 'USDC' }], state.accepts[0] || 'eth', function (k) {
      state.accepts = [k]; render();
    }));
    var note = el('div', 'create-hint');
    note.textContent = 'The token that makes up your project’s balance.';
    w.appendChild(note);
    var line2 = el('div', 'create-hint');
    line2.appendChild(document.createTextNode(state.swapRouter
      ? 'Other payment tokens auto-swap to your chosen accounting token as they’re paid in. '
      : 'Payers can only pay in your accounting token. '));
    var toggle = el('a', 'create-inline-toggle'); toggle.href = '#';
    toggle.textContent = state.swapRouter ? 'Disable giving payers this option' : 'Enable giving payers this option';
    toggle.addEventListener('click', function (e) { e.preventDefault(); state.swapRouter = !state.swapRouter; render(); });
    line2.appendChild(toggle);
    w.appendChild(line2);
    return w;
  })()));

  // Project links
  wrap.appendChild(collapse(d, 'linksOpen', 'Project links', true, render, function () {
    var g = el('div', 'create-grid2');
    g.appendChild(fieldBlock('Website', true, textInput(d.website, 'https://…', function (v) { d.website = v; })));
    g.appendChild(fieldBlock('Twitter handle', true, textInput(d.twitter, '@handle', function (v) { d.twitter = v; })));
    g.appendChild(fieldBlock('Discord', true, textInput(d.discord, 'https://discord.gg/…', function (v) { d.discord = v; })));
    g.appendChild(fieldBlock('Telegram', true, textInput(d.telegram, 'https://t.me/…', function (v) { d.telegram = v; })));
    return g;
  }));

  // Owner
  wrap.appendChild(collapse(d, 'ownerOpen', 'Project owner', true, render, function () {
    var c = el('div', '');
    c.appendChild(infoNote('Leave blank to make your connected wallet the owner. Enter an address to assign ownership to it. Ensure the address exists on every chain you deploy to.'));
    c.appendChild(toggleRow('Make immutable after deploy', 'Burns ownership to a dead address so the project’s rules can never be changed by anyone.', d.immutable, function (v) { d.immutable = v; render(); }));
    if (!d.immutable) {
      var ownerField = fieldBlock(null, false, textInput(d.owner, '0x0000000000000000000000000000000000000000', function (v) { d.owner = v.trim(); }));
      ownerField.style.marginTop = '10px';
      c.appendChild(ownerField);
    }
    return c;
  }));

  // Tags
  wrap.appendChild(collapse(d, 'tagsOpen', 'Project tags', true, render, function () {
    var c = el('div', 'create-tags');
    TAG_OPTIONS.forEach(function (tag) {
      var on = d.tags.indexOf(tag) !== -1;
      var pill = el('button', 'create-tag' + (on ? ' selected' : ''));
      pill.textContent = tag;
      pill.addEventListener('click', function () {
        if (on) d.tags = d.tags.filter(function (x) { return x !== tag; });
        else if (d.tags.length < 3) d.tags.push(tag);
        render();
      });
      c.appendChild(pill);
    });
    var hint = el('div', 'create-hint'); hint.textContent = 'Select up to 3 tags to help supporters find your project.';
    hint.style.marginBottom = '12px';
    var w = el('div', ''); w.appendChild(hint); w.appendChild(c);
    return w;
  }));

  // Page customizations
  wrap.appendChild(collapse(d, 'customOpen', 'Project page customizations', true, render, function () {
    var c = el('div', '');
    c.appendChild(fieldBlock('Cover image', true, renderImagePicker(d.coverImageUri, false, function (uri) { d.coverImageUri = uri; render(); })));
    c.appendChild(fieldBlock('Payment notice', true, textArea(d.payDisclosure, 'Shown to payers before they pay.', function (v) { d.payDisclosure = v; })));
    return c;
  }));

  return wrap;
}

// Standard image uploader, matching the project page: a square preview thumb + native "Choose File",
// pinned to IPFS on pick. `busy` shows an inline "Uploading…" hint.
function renderImagePicker(uri, busy, onChange) {
  var w = el('div', 'operator-edit-logo');
  var prev = el('img', 'operator-edit-logo-prev');
  if (uri) { prev.src = ipfsHttp(uri); } else { prev.style.display = 'none'; }
  w.appendChild(prev);
  var file = el('input', 'operator-edit-logo-file');
  file.type = 'file'; file.accept = 'image/*';
  file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (!f) { onChange('', false); return; } // picker dismissed → clear
    if (!hasPinata()) { alert('Add a Pinata JWT in DATA → settings to upload images.'); return; }
    onChange(uri, true);
    pinFile(f, f.name).then(function (ipfs) { onChange(ipfs, false); })
      .catch(function (e) { alert('Upload failed: ' + (e && e.message || e)); onChange(uri, false); });
  });
  w.appendChild(file);
  if (busy) { var hint = el('span', 'operator-edit-hint'); hint.textContent = 'Uploading…'; w.appendChild(hint); }
  return w;
}

// ---------------------------------------------------------------------------
// Step 1: Stages (one or more rulesets queued at launch, revnet-style)
// ---------------------------------------------------------------------------

// A stage === one JBRulesetConfig. Field names are chosen so the token/payouts/deadline
// section renderers below read straight off the stage object.
function createStage() {
  return {
    expanded: false,         // collapsed by default — sensible defaults are summarized in the card head
    durationSeconds: 0,      // 0 = no expiry (final stage); non-final stages need a duration to advance
    durationCustom: false, customDurVal: '', customDurUnit: 'days',  // custom duration (value × unit)
    schedule: '', scheduleOn: false,  // stage 1 only: scheduled launch (mustStartAtOrAfter); scheduleOn=false means launch right away
    baseCurrency: 1,         // issuance-rate denomination (ETH=1 / USD=2) — metadata.baseCurrency
    payoutCurrency: 1,       // payout-limit denomination (ETH=1 / USD=2) — JBCurrencyAmount.currency
    // token — by default the project issues 10,000 tokens per ETH/USD
    tokenMode: 'custom', weight: '10000', reservedPercent: 0, weightCutPercent: 0,
    cashOutEnabled: false, cashOutTaxRate: 0, allowOwnerMinting: false, pauseTransfers: false,
    reservedRecipients: [], tokenAdvancedOpen: false,
    // payouts
    payoutMode: 'none', payoutRecipients: [],
    // surplus allowance — owner can withdraw from surplus (beyond payouts) up to a cap each ruleset
    surplusAllowanceOn: false, surplusAllowanceUnlimited: false, surplusAllowanceAmount: '', surplusAllowanceCurrency: 1,
    // deadline + rules
    deadline: '3days', pausePay: false, holdFees: false,
    allowSetTerminals: true, allowSetController: true, allowTerminalMigration: false, otherOpen: false,
    // editor section collapses
    tokenOpen: true, payoutsOpen: false, deadlineOpen: false,
  };
}

function renderStages(state, render) {
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Rulesets', 'Set the sequential rulesets your project follows over time.'));

  state.stages.forEach(function (stage, idx) {
    wrap.appendChild(renderStageCard(stage, idx, state, render));
  });

  if (needsStandby(state.stages)) {
    wrap.appendChild(infoNote('Heads up: with a single timed stage, a “standby” ruleset is appended automatically after it (no issuance, no payouts, payments paused, cash-outs preserved) so the project runs Stage 1 once and then idles safely instead of auto-repeating. You’ll see it in the Deploy payload. Add a Stage 2 to define what comes next yourself.'));
  }

  var add = el('a', 'operator-cta create-add-link'); add.href = '#';
  add.textContent = '+ Add ruleset';
  add.addEventListener('click', function (e) {
    e.preventDefault();
    var prev = state.stages[state.stages.length - 1];
    var s = createStage();
    if (prev) { s.tokenMode = prev.tokenMode; s.deadline = prev.deadline; s.baseCurrency = prev.baseCurrency; s.payoutCurrency = prev.payoutCurrency; } // sensible carry-over
    state.stages.forEach(function (x) { x.expanded = false; });
    s.expanded = true;
    state.stages.push(s);
    render();
  });
  wrap.appendChild(add);
  return wrap;
}

function renderStageCard(stage, idx, state, render) {
  var card = el('div', 'create-stage-card');
  var head = el('div', 'create-stage-head');
  head.addEventListener('click', function (e) { if (e.target.closest('.create-stage-remove')) return; stage.expanded = !stage.expanded; render(); });
  var left = el('div', 'create-stage-headtext');
  var title = el('div', 'create-stage-title'); title.textContent = 'Ruleset #' + (idx + 1); left.appendChild(title);
  var sum = el('div', 'create-stage-sum'); sum.textContent = stageSummary(stage, idx, state); left.appendChild(sum);
  head.appendChild(left);
  if (idx > 0) {
    var rm = el('button', 'create-stage-remove'); rm.textContent = '✕';
    rm.addEventListener('click', function () { state.stages.splice(idx, 1); render(); });
    head.appendChild(rm);
  }
  var caret = el('span', 'create-stage-caret'); caret.textContent = stage.expanded ? '▴' : '▾'; head.appendChild(caret);
  card.appendChild(head);
  if (stage.expanded) card.appendChild(renderStageEditor(stage, idx, state, render));
  return card;
}

function stageSummary(stage, idx, state) {
  var parts = [];
  parts.push(idx === 0 ? ((stage.scheduleOn && stage.schedule) ? 'Starts at a set time' : 'Starts at launch') : 'Starts after Ruleset #' + idx);
  parts.push(stage.durationSeconds ? ('lasts ' + secondsLabel(stage.durationSeconds)) : 'lasts forever');
  if (stage.tokenMode === 'custom') {
    parts.push('issues ' + (stage.weight || '0') + ' tokens / ' + (stage.baseCurrency === 2 ? 'USD' : 'ETH'));
  } else parts.push('no issuance');
  if (stage.payoutMode && stage.payoutMode !== 'none') parts.push(stage.payoutMode + ' payouts');
  if (stage.surplusAllowanceOn) parts.push('surplus allowance');
  return parts.join(' · ');
}

function renderStageEditor(stage, idx, state, render) {
  var c = el('div', 'create-stage-body');
  c.appendChild(stageTiming(stage, idx, idx === state.stages.length - 1, render));
  c.appendChild(tokenSection(stage, render));
  c.appendChild(collapse(stage, 'payoutsOpen', 'Payouts', false, render, function () { return payoutsSection(stage, render); }));
  c.appendChild(collapse(stage, 'deadlineOpen', 'Edit deadline & rules', false, render, function () { return deadlineSection(stage, render); }));
  return c;
}

function stageTiming(stage, idx, isLast, render) {
  var w = el('div', '');
  // Duration (None + presets)
  var f = el('div', 'create-field');
  var lab = el('label', 'create-label'); lab.textContent = 'Duration'; f.appendChild(lab);
  var sel = el('select', 'field create-input');
  var none = el('option', ''); none.value = '0'; none.textContent = 'Forever';
  if (!stage.durationCustom && !stage.durationSeconds) none.selected = true; sel.appendChild(none);
  DURATION_PRESETS.forEach(function (p) {
    var opt = el('option', ''); opt.value = String(p.seconds); opt.textContent = p.label;
    if (!stage.durationCustom && stage.durationSeconds === p.seconds) opt.selected = true; sel.appendChild(opt);
  });
  var customOpt = el('option', ''); customOpt.value = 'custom'; customOpt.textContent = 'Custom…';
  if (stage.durationCustom) customOpt.selected = true; sel.appendChild(customOpt);
  sel.addEventListener('change', function () {
    if (sel.value === 'custom') { stage.durationCustom = true; recomputeCustomDuration(stage); }
    else { stage.durationCustom = false; stage.durationSeconds = Number(sel.value); }
    render();
  });
  f.appendChild(sel);
  if (stage.durationCustom) {
    var crow = el('div', 'create-amount-row'); crow.style.marginTop = '8px';
    var num = el('input', 'field create-amount-input'); num.type = 'number'; num.min = '1'; num.step = '1'; num.placeholder = '1'; num.value = stage.customDurVal;
    num.addEventListener('input', function () { stage.customDurVal = num.value.trim(); recomputeCustomDuration(stage); render(); });
    var unit = el('select', 'create-amount-cur');
    ['hours', 'days', 'weeks', 'years'].forEach(function (u) { var op = el('option', ''); op.value = u; op.textContent = u; if (stage.customDurUnit === u) op.selected = true; unit.appendChild(op); });
    unit.addEventListener('change', function () { stage.customDurUnit = unit.value; recomputeCustomDuration(stage); render(); });
    crow.appendChild(num); crow.appendChild(unit);
    f.appendChild(crow);
  }
  w.appendChild(f);

  if (idx === 0) {
    w.appendChild(toggleRow('Launch right away', '', !stage.scheduleOn, function (v) {
      stage.scheduleOn = !v;
      if (v) stage.schedule = ''; // launching now clears any scheduled time
      render();
    }));
    if (stage.scheduleOn) {
      var ww = el('div', '');
      var sub = el('div', 'create-hint'); sub.textContent = 'Your project will start at this date.'; ww.appendChild(sub);
      var i = el('input', 'field create-input'); i.type = 'datetime-local'; i.style.marginTop = '4px';
      if (stage.schedule) i.value = tsToLocal(stage.schedule);
      i.addEventListener('input', function () {
        if (!i.value) { stage.schedule = ''; return; }
        var dt = new Date(i.value); stage.schedule = isNaN(dt.getTime()) ? '' : Math.floor(dt.getTime() / 1000);
      });
      ww.appendChild(i);
      var tz = el('div', 'create-hint'); tz.textContent = localTimezoneLabel(); ww.appendChild(tz);
      w.appendChild(fieldBlock(null, false, ww));
    }
  } else {
    w.appendChild(infoNote('Stage ' + (idx + 1) + ' begins automatically when Stage ' + idx + ' ends.'));
  }
  // A non-final stage with no duration would never advance — the next stage would start at the same
  // instant and immediately clobber it. Require a duration on every non-final stage.
  if (!isLast && !stage.durationSeconds) {
    w.appendChild(warnNote('⚠ This stage isn’t the last, so it needs a duration. With “no expiry”, the next stage would start at the same moment and override this one. Set a duration so Stage ' + (idx + 2) + ' begins when this stage’s cycle ends.'));
  }
  return w;
}

function choiceCardsInline(opts, current, onPick) {
  var row = el('div', 'create-pills');
  opts.forEach(function (o) {
    var p = el('button', 'create-pill' + (current === o.key ? ' selected' : ''));
    p.textContent = o.label;
    p.addEventListener('click', function () { onPick(o.key); });
    row.appendChild(p);
  });
  return row;
}


// Payouts section for a stage (folded into the stage editor).
function payoutsSection(stage, render) {
  var wrap = el('div', '');
  wrap.appendChild(infoNote('Anyone can pay this project. Optionally route a portion to wallets or other Juicebox projects. Unpaid ETH stays for cash outs / later stages. Payouts reset each ruleset.'));

  wrap.appendChild(choiceCards([
    { key: 'none', title: 'None', sub: 'No ETH can be paid out. All ETH stays for cash outs / future stages.', icon: '⦸' },
    { key: 'limited', title: 'Limited', sub: 'A fixed amount of ETH can be paid out each ruleset.', icon: '◎' },
    { key: 'unlimited', title: 'Unlimited', sub: 'All ETH can be paid out at any time.', icon: '∞' },
  ], stage.payoutMode, function (k) { stage.payoutMode = k; render(); }));

  if (stage.payoutMode !== 'none') {
    var unit = stage.payoutCurrency === 2 ? 'USD' : 'ETH';

    var card = el('div', 'create-subcard');
    var head = el('div', 'create-subcard-head');
    var t = el('div', 'create-subcard-title'); t.textContent = 'Payout recipients';
    head.appendChild(t);
    var add = el('button', 'create-btn small');
    add.textContent = '+ Add recipient';
    add.addEventListener('click', function () {
      openRecipientModal('payout', function (rec) { stage.payoutRecipients.push(rec); render(); }, stage);
    });
    head.appendChild(add);
    card.appendChild(head);

    if (!stage.payoutRecipients.length) {
      var empty = el('div', 'create-empty'); empty.textContent = 'No payout recipients';
      card.appendChild(empty);
    } else {
      stage.payoutRecipients.forEach(function (rec, idx) {
        card.appendChild(recipientRow(rec, stage.payoutMode === 'limited' ? (rec.amountEth + ' ' + unit) : 'share', function () {
          stage.payoutRecipients.splice(idx, 1); render();
        }));
      });
    }
    wrap.appendChild(card);
    wrap.appendChild(infoNote(stage.payoutMode === 'limited'
      ? 'Limited: this ruleset can pay out the sum of the recipients’ amounts (in ' + unit + '). Remaining funds stay in the project.'
      : 'Unlimited: recipients receive their relative share of payouts; any remainder is withdrawable by the owner.'));
  }

  // Surplus allowance — separate from payouts: the owner can withdraw from the project's surplus
  // (anything beyond payout limits) up to this cap each ruleset. Off by default.
  wrap.appendChild(toggleRow('Surplus allowance', 'Let the owner withdraw from the project’s surplus (funds beyond payouts) each ruleset, up to a cap you set. Off by default.', stage.surplusAllowanceOn, function (v) { stage.surplusAllowanceOn = v; render(); }));
  if (stage.surplusAllowanceOn) {
    var saCard = el('div', 'create-subcard');
    saCard.appendChild(toggleRow('Unlimited', '', stage.surplusAllowanceUnlimited, function (v) { stage.surplusAllowanceUnlimited = v; render(); }));
    if (!stage.surplusAllowanceUnlimited) {
      saCard.appendChild(fieldBlock('Allowance per ruleset', false, (function () {
        var rowEl = el('div', 'create-amount-row');
        var amt = el('input', 'field create-amount-input'); amt.type = 'text'; amt.placeholder = '0.0'; amt.value = stage.surplusAllowanceAmount;
        amt.addEventListener('input', function () { stage.surplusAllowanceAmount = amt.value.trim(); });
        var curSel = el('select', 'create-amount-cur');
        [['ETH', 1], ['USD', 2]].forEach(function (o) {
          var op = el('option', ''); op.value = String(o[1]); op.textContent = o[0];
          if (stage.surplusAllowanceCurrency === o[1]) op.selected = true;
          curSel.appendChild(op);
        });
        curSel.addEventListener('change', function () { stage.surplusAllowanceCurrency = Number(curSel.value); });
        rowEl.appendChild(amt); rowEl.appendChild(curSel);
        return rowEl;
      })()));
    }
    wrap.appendChild(saCard);
  }
  return wrap;
}

function recipientRow(rec, right, onRemove) {
  var row = el('div', 'create-recipient');
  var who = el('span', 'create-recipient-who');
  who.textContent = rec.type === 'project' ? ('Project #' + rec.projectId) : shortAddr(rec.address);
  row.appendChild(who);
  var r = el('span', 'create-recipient-right');
  r.textContent = right;
  row.appendChild(r);
  var x = el('button', 'create-recipient-x');
  x.textContent = '✕';
  x.addEventListener('click', onRemove);
  row.appendChild(x);
  return row;
}

// Inline reserved-token split row: "Split [%] to [0x / project ID]". A project ID reveals a
// "token beneficiary" field (who receives that project's tokens). Edits `rec` in place.
function reservedSplitRow(t, rec, idx, render, onTotal) {
  var wrap = el('div', 'create-split-wrap');
  var row = el('div', 'create-split-row');
  var lead = el('span', 'create-split-lead'); lead.textContent = idx === 0 ? 'Split' : '… and'; row.appendChild(lead);
  var pct = el('input', 'field create-split-pct'); pct.type = 'number'; pct.min = '0'; pct.max = '100'; pct.step = 'any'; pct.placeholder = '10';
  pct.value = rec.percent || ''; pct.addEventListener('input', function () { rec.percent = parseFloat(pct.value) || 0; if (onTotal) onTotal(); }); row.appendChild(pct);
  var sign = el('span', 'create-split-sign'); sign.textContent = '%'; row.appendChild(sign);
  var to = el('span', 'create-split-to'); to.textContent = 'to'; row.appendChild(to);
  var recip = el('input', 'field create-split-recip'); recip.type = 'text'; recip.placeholder = '0x… or project ID';
  recip.value = rec.type === 'project' ? String(rec.projectId || '') : (rec.address || ''); row.appendChild(recip);
  var rm = el('button', 'create-split-rm'); rm.textContent = '🗑'; rm.title = 'Remove';
  rm.addEventListener('click', function () { var i = t.reservedRecipients.indexOf(rec); if (i >= 0) t.reservedRecipients.splice(i, 1); render(); });
  row.appendChild(rm);
  wrap.appendChild(row);
  // Project-ID beneficiary line.
  var benefRow = el('div', 'create-split-benef'); benefRow.style.display = 'none';
  var benef = el('input', 'field'); benef.type = 'text'; benef.placeholder = '0x… who receives that project’s tokens';
  benef.value = rec.type === 'project' ? (rec.address || '') : '';
  benef.addEventListener('input', function () { rec.address = benef.value.trim(); });
  benefRow.appendChild(benef); wrap.appendChild(benefRow);
  function refresh() {
    var v = (recip.value || '').trim();
    if (/^[0-9]+$/.test(v) && Number(v) > 0) { rec.type = 'project'; rec.projectId = Number(v); benefRow.style.display = ''; }
    else { rec.type = 'wallet'; rec.projectId = 0; rec.address = v; benefRow.style.display = 'none'; }
  }
  recip.addEventListener('input', refresh);
  refresh();
  return wrap;
}

// Token issuance section for a stage (folded into the stage editor).
function tokenSection(stage, render) {
  var t = stage;
  var wrap = el('div', '');
  wrap.appendChild(toggleRow('Issues tokens when paid', '', t.tokenMode === 'custom', function (v) { t.tokenMode = v ? 'custom' : 'none'; render(); }));

  if (t.tokenMode === 'custom') {
    var card = el('div', 'create-subcard');

    // Issues [x] tokens per [ETH/USD]
    card.appendChild((function () {
      var row = el('div', 'create-inline-row');
      row.appendChild(document.createTextNode('Issues '));
      var n = el('input', 'field create-inline-num'); n.type = 'text'; n.placeholder = '0'; n.value = t.weight;
      n.addEventListener('input', function () { t.weight = n.value.trim(); });
      row.appendChild(n);
      row.appendChild(document.createTextNode(' tokens per '));
      var cur = el('select', 'create-amount-cur');
      [['ETH', 1], ['USD', 2]].forEach(function (o) { var op = el('option', ''); op.value = String(o[1]); op.textContent = o[0]; if (t.baseCurrency === o[1]) op.selected = true; cur.appendChild(op); });
      cur.addEventListener('change', function () { t.baseCurrency = Number(cur.value); render(); });
      row.appendChild(cur);
      return row;
    })());

    // Reserved splits — each "Split [%] to [recipient]" reserves that share of issuance; the payer gets
    // the rest. The percentages sum to the project's reserved rate (shown in the summary below).
    var rlbl = el('div', 'create-label'); rlbl.style.marginTop = '14px'; rlbl.textContent = 'Reserved'; card.appendChild(rlbl);
    card.appendChild(infoNote('Reserve a share of every token issuance for wallets / projects you choose.'));
    var sumNote = el('div', 'create-hint');
    function updateReservedSummary() {
      var tot = Math.round(t.reservedRecipients.reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0) * 100) / 100;
      sumNote.textContent = 'Total split limit of ' + tot + '%, payer always receives ' + (Math.round((100 - tot) * 100) / 100) + '% of issuance.';
      sumNote.className = 'create-hint' + (tot > 100 ? ' warn' : '');
    }
    t.reservedRecipients.forEach(function (rec, i) { card.appendChild(reservedSplitRow(t, rec, i, render, updateReservedSummary)); });
    var addSplit = el('a', 'operator-cta create-add-link'); addSplit.href = '#'; addSplit.textContent = 'add split +';
    addSplit.addEventListener('click', function (e) { e.preventDefault(); t.reservedRecipients.push({ type: 'wallet', address: '', projectId: 0, percent: 0 }); render(); });
    card.appendChild(addSplit);
    if (t.reservedRecipients.length) { updateReservedSummary(); card.appendChild(sumNote); }

    card.appendChild(collapse(t, 'tokenAdvancedOpen', 'Advanced', false, render, function () {
      var c = el('div', '');
      var icl = el('label', 'create-label'); icl.textContent = 'Issuance cut'; c.appendChild(icl);
      c.appendChild(infoNote('The issuance rate drops by this much each stage cycle. Higher = more reason to pay earlier.'));
      c.appendChild(pctSlider(t.weightCutPercent, function (v) { t.weightCutPercent = v; }));
      c.appendChild(toggleRow('Enable cash outs', 'When enabled, token holders can cash out their tokens for a portion of the project’s ETH.', t.cashOutEnabled, function (v) { t.cashOutEnabled = v; render(); }));
      if (t.cashOutEnabled) {
        var col = el('label', 'create-label'); col.textContent = 'Cash out tax'; c.appendChild(col);
        c.appendChild(infoNote('At 0%, cash outs are 1:1. Higher rates leave relatively more ETH for those who cash out later.'));
        c.appendChild(pctSlider(t.cashOutTaxRate, function (v) { t.cashOutTaxRate = v; }));
      }
      c.appendChild(toggleRow('Owner token minting', 'While enabled, the project owner can mint any amount of project tokens.', t.allowOwnerMinting, function (v) { t.allowOwnerMinting = v; }));
      c.appendChild(toggleRow('Pause token transfers', 'While paused, project credits can’t be transferred (ERC-20s, once issued, are always transferable).', t.pauseTransfers, function (v) { t.pauseTransfers = v; }));
      return c;
    }));

    wrap.appendChild(card);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// Step 4: NFTs
// ---------------------------------------------------------------------------

function renderNfts(state, render) {
  var wrap = el('div', '');
  var head = stepHead('Shop', 'Sell items that supporters mint by paying your project. You can change an item’s image later, but not its price or how many exist after launch.');
  var badge = el('span', 'create-step-badge'); badge.textContent = 'OPTIONAL';
  head.querySelector('.create-step-title').appendChild(badge);
  wrap.appendChild(head);

  state.nfts.forEach(function (nft, idx) {
    var row = el('div', 'create-nft-row');
    if (nft.imageUri) { var im = el('img', 'create-nft-thumb'); im.src = ipfsHttp(nft.imageUri); row.appendChild(im); }
    var meta = el('div', 'create-nft-meta');
    var nm = el('div', 'create-nft-name'); nm.textContent = nft.name || 'Untitled item'; meta.appendChild(nm);
    var pr = el('div', 'create-nft-price'); pr.textContent = (nft.priceEth || '0') + ' ETH' + (nft.limited ? (' · ' + (nft.supply || '0') + ' for sale') : ' · unlimited'); meta.appendChild(pr);
    row.appendChild(meta);
    var ed = el('button', 'create-btn small ghost'); ed.textContent = 'Edit';
    ed.addEventListener('click', function () { openNftModal(nft, function (updated) { state.nfts[idx] = updated; render(); }); });
    row.appendChild(ed);
    var rm = el('button', 'create-recipient-x'); rm.textContent = '✕';
    rm.addEventListener('click', function () { state.nfts.splice(idx, 1); render(); });
    row.appendChild(rm);
    wrap.appendChild(row);
  });

  var add = el('button', 'create-add-nft');
  add.textContent = '＋ Add item for sale';
  add.addEventListener('click', function () { openNftModal(null, function (nft) { state.nfts.push(nft); render(); }); });
  wrap.appendChild(add);
  return wrap;
}

// Deadline + other-rules section for a stage (folded into the stage editor).
function deadlineSection(stage, render) {
  var wrap = el('div', '');
  wrap.appendChild(infoNote('Edits must be submitted before this deadline ahead of the next ruleset, giving token holders time to verify changes before they take effect.'));

  DEADLINE_OPTIONS.forEach(function (o) {
    var card = el('button', 'create-deadline' + (stage.deadline === o.key ? ' selected' : ''));
    var dot = el('span', 'create-radio' + (stage.deadline === o.key ? ' on' : ''));
    card.appendChild(dot);
    var lab = el('span', 'create-deadline-label'); lab.textContent = o.label; card.appendChild(lab);
    if (o.def) { var bd = el('span', 'create-choice-badge'); bd.textContent = 'DEFAULT'; card.appendChild(bd); }
    card.addEventListener('click', function () { stage.deadline = o.key; render(); });
    wrap.appendChild(card);
  });
  if (stage.deadline === 'none') wrap.appendChild(infoNote('No deadline leaves this stage vulnerable to last-second edits by the owner, which may appear risky to supporters.'));

  wrap.appendChild(collapse(stage, 'otherOpen', 'Other rules', true, render, function () {
    var c = el('div', '');
    c.appendChild(toggleRow('Pause payments', 'While paused, the project cannot receive payments (direct ETH transfers still work).', stage.pausePay, function (v) { stage.pausePay = v; }));
    c.appendChild(toggleRow('Hold fees', 'Hold fees in the project instead of processing them automatically.', stage.holdFees, function (v) { stage.holdFees = v; }));
    c.appendChild(toggleRow('Allow setting payment terminals', 'The owner can add/remove payment terminals at any time.', stage.allowSetTerminals, function (v) { stage.allowSetTerminals = v; }));
    c.appendChild(toggleRow('Allow setting controller', 'The owner can change the project’s controller at any time.', stage.allowSetController, function (v) { stage.allowSetController = v; }));
    c.appendChild(toggleRow('Allow terminal migration', 'The owner can migrate the project’s terminals to a new version.', stage.allowTerminalMigration, function (v) { stage.allowTerminalMigration = v; }));
    return c;
  }));
  return wrap;
}

// ---------------------------------------------------------------------------
// Step 6: Deploy
// ---------------------------------------------------------------------------

function renderDeploy(state, render) {
  var wrap = el('div', '');
  wrap.appendChild(stepHead('Review & Deploy', 'Pick the chains to deploy on, review, and launch.'));

  // Chain select
  var net = networkOf(state.chainIds[0]);
  var label = el('div', 'create-label'); label.textContent = 'Select chains:'; wrap.appendChild(label);
  var netRow = el('div', 'create-pills');
  ['mainnet', 'testnet'].forEach(function (n) {
    var p = el('button', 'create-pill' + (net === n ? ' selected' : ''));
    p.textContent = n;
    p.addEventListener('click', function () {
      if (n === net) return;
      var first = CHAIN_OPTIONS.find(function (c) { return (n === 'testnet') === c.testnet; });
      state.chainIds = first ? [first.id] : []; render();
    });
    netRow.appendChild(p);
  });
  wrap.appendChild(netRow);

  var chainRow = el('div', 'create-chain-row');
  CHAIN_OPTIONS.filter(function (c) { return c.testnet === (net === 'testnet'); }).forEach(function (c) {
    var on = state.chainIds.indexOf(c.id) !== -1;
    var pill = el('button', 'create-chain-pill' + (on ? ' selected' : ''));
    pill.textContent = c.name;
    pill.addEventListener('click', function () {
      var ids = state.chainIds.slice();
      if (on) ids = ids.filter(function (x) { return x !== c.id; });
      else ids.push(c.id);
      state.chainIds = ids.length ? ids : [c.id];
      render();
    });
    chainRow.appendChild(pill);
  });
  wrap.appendChild(chainRow);
  wrap.appendChild(infoNote(state.chainIds.length > 1
    ? 'Deploys on ' + state.chainIds.length + ' chains, linked so your token and balances can move between them. You’ll sign one transaction per chain.'
    : 'Deploys on a single chain. You can add more chains here before launching.'));

  // Review summary
  wrap.appendChild(reviewSummary(state));

  // The exact transaction for each chain is shown in a confirmation screen (with a copy-able LLM audit
  // prompt) right before you sign it — no need to re-review raw calldata here.
  wrap.appendChild(infoNote(state.chainIds.length > 1
    ? 'You’ll sign one transaction per chain. Each one’s exact data is shown for review before you sign it.'
    : 'The exact transaction data is shown for review before you sign it.'));

  // ToS + launch
  var tos = el('label', 'create-tos');
  var cb = el('input', ''); cb.type = 'checkbox'; cb.checked = state.tos;
  cb.addEventListener('change', function () { state.tos = cb.checked; updateLaunch(); });
  tos.appendChild(cb);
  tos.appendChild(document.createTextNode(' I understand this is a brand-new protocol and accept the risks of deploying.'));
  wrap.appendChild(tos);

  if (!hasPinata()) wrap.appendChild(infoNote('No Pinata JWT set — add one in DATA → settings to pin your logo & metadata. Otherwise they’re skipped at launch and you can add them by editing the project later.'));

  if (state.statusLines.length) {
    var log = el('div', 'create-log');
    state.statusLines.forEach(function (line) {
      var l = el('div', 'create-log-line' + (line.err ? ' err' : (line.ok ? ' ok' : '')));
      l.textContent = line.text;
      log.appendChild(l);
    });
    wrap.appendChild(log);
  }

  var bad = badStageIndex(state);
  var launch = el('button', 'create-btn primary big');
  function updateLaunch() {
    launch.disabled = state.deploying || !state.tos || !state.chainIds.length || !state.details.name || bad !== -1;
  }
  launch.textContent = state.done ? 'Launched √' : (state.deploying ? 'Launching…' : 'Launch project');
  launch.addEventListener('click', function () { deploy(state, render); });
  updateLaunch();
  wrap.appendChild(launch);
  if (!state.details.name) wrap.appendChild(infoNote('Add a project name on the Details step to launch.'));
  if (bad !== -1) wrap.appendChild(warnNote('Stage ' + (bad + 1) + ' has no duration but isn’t the last stage. Give it a duration on the Stages step so Stage ' + (bad + 2) + ' starts when its cycle ends.'));

  return wrap;
}

function reviewSummary(state) {
  var c = el('div', 'create-review');
  function row(k, v) {
    var r = el('div', 'create-review-row');
    var kk = el('span', 'create-review-k'); kk.textContent = k;
    var vv = el('span', 'create-review-v'); vv.textContent = v;
    r.appendChild(kk); r.appendChild(vv); return r;
  }
  c.appendChild(row('Name', state.details.name || '—'));
  c.appendChild(row('Accounting token', state.accepts.map(function (a) { return a.toUpperCase(); }).join(' + ') + (state.swapRouter ? ' (+ any via router)' : '')));
  c.appendChild(row('Launch', state.stages[0] && state.stages[0].schedule
    ? new Date(Number(state.stages[0].schedule) * 1000).toLocaleString() : 'Immediately'));
  c.appendChild(row('Stages', String(state.stages.length) + (needsStandby(state.stages) ? ' (+ standby)' : '')));
  state.stages.forEach(function (s, i) { c.appendChild(row('Stage ' + (i + 1), stageSummary(s, i, state))); });
  if (needsStandby(state.stages)) c.appendChild(row('Stage 2', 'standby · after Stage 1 · no expiry · paused, no issuance'));
  c.appendChild(row('Shop', state.nfts.length ? (state.nfts.length + ' item(s)') : 'None'));
  c.appendChild(row('Chains', state.chainIds.map(chainName).join(', ')));
  return c;
}

// ---------------------------------------------------------------------------
// Recipient modal (payouts + reserved)
// ---------------------------------------------------------------------------

// For payout recipients, `stage` is passed so the amount field's trailing ETH/USD selector reads/writes
// the stage's payout currency (currency is a property of the payout limit, shared across recipients).
function openRecipientModal(kind, onAdd, stage) {
  var rec = { type: 'wallet', address: '', projectId: '', amountEth: '', percent: 0, lockedUntil: '' };
  var ov = el('div', 'create-modal-overlay');
  var dlg = el('div', 'create-modal');
  function close() { ov.remove(); }
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

  var title = el('div', 'create-modal-title');
  title.textContent = kind === 'payout' ? 'Add payout recipient' : 'Add reserved token recipient';
  dlg.appendChild(title);

  var typeRow = el('div', 'create-pills');
  [['wallet', 'Wallet Address'], ['project', 'Juicebox Project']].forEach(function (o) {
    var p = el('button', 'create-pill' + (rec.type === o[0] ? ' selected' : ''));
    p.textContent = o[1];
    p.addEventListener('click', function () { rec.type = o[0]; body(); });
    typeRow.appendChild(p);
  });
  dlg.appendChild(typeRow);

  var fields = el('div', '');
  dlg.appendChild(fields);
  function body() {
    Array.prototype.forEach.call(typeRow.children, function (p, i) {
      p.classList.toggle('selected', (i === 0) === (rec.type === 'wallet'));
    });
    fields.innerHTML = '';
    if (rec.type === 'project') {
      fields.appendChild(fieldBlock('Juicebox Project ID', false, textInput(rec.projectId, '#', function (v) { rec.projectId = v.trim(); })));
      fields.appendChild(fieldBlock('Token beneficiary address', false, textInput(rec.address, '0x…', function (v) { rec.address = v.trim(); })));
    } else {
      fields.appendChild(fieldBlock('Address', false, textInput(rec.address, '0x…', function (v) { rec.address = v.trim(); })));
    }
    if (kind === 'payout') {
      // Amount + trailing ETH/USD selector (like the Pay form's value field). The selector sets the
      // stage's payout currency, naming which unit the amount is measured in.
      fields.appendChild(fieldBlock('Payout amount', false, (function () {
        var rowEl = el('div', 'create-amount-row');
        var amt = el('input', 'field create-amount-input'); amt.type = 'text'; amt.placeholder = '0.0'; amt.value = rec.amountEth;
        amt.addEventListener('input', function () { rec.amountEth = amt.value.trim(); });
        var curSel = el('select', 'create-amount-cur');
        [['ETH', 1], ['USD', 2]].forEach(function (o) {
          var op = el('option', ''); op.value = String(o[1]); op.textContent = o[0];
          if ((stage && stage.payoutCurrency) === o[1]) op.selected = true;
          curSel.appendChild(op);
        });
        curSel.addEventListener('change', function () { if (stage) stage.payoutCurrency = Number(curSel.value); });
        rowEl.appendChild(amt); rowEl.appendChild(curSel);
        return rowEl;
      })()));
    } else {
      var pf = el('div', 'create-field');
      var pl = el('label', 'create-label'); pl.textContent = 'Reserved percentage'; pf.appendChild(pl);
      pf.appendChild(pctSlider(rec.percent, function (v) { rec.percent = v; }));
      fields.appendChild(pf);
    }
  }
  body();

  var foot = el('div', 'create-modal-foot');
  var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel';
  cancel.addEventListener('click', close);
  var ok = el('button', 'create-btn primary'); ok.textContent = kind === 'payout' ? 'Add payout' : 'Add recipient';
  ok.addEventListener('click', function () {
    if (rec.type === 'wallet' && !/^0x[0-9a-fA-F]{40}$/.test(rec.address)) { alert('Enter a valid address.'); return; }
    if (rec.type === 'project' && !rec.projectId) { alert('Enter a project ID.'); return; }
    onAdd(rec); close();
  });
  foot.appendChild(cancel); foot.appendChild(ok);
  dlg.appendChild(foot);

  ov.appendChild(dlg);
  document.body.appendChild(ov);
}

// ---------------------------------------------------------------------------
// NFT modal
// ---------------------------------------------------------------------------

function openNftModal(existing, onSave) {
  var nft = existing ? Object.assign({}, existing) : {
    name: '', description: '', priceEth: '', imageUri: '', imageUploading: false,
    limited: false, supply: '', reserveFrequency: '', reserveBeneficiary: '', externalLink: '', advOpen: false,
  };
  var ov = el('div', 'create-modal-overlay');
  var dlg = el('div', 'create-modal');
  function close() { ov.remove(); }
  ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });

  function body() {
    dlg.innerHTML = '';
    var title = el('div', 'create-modal-title'); title.textContent = existing ? 'Edit item' : 'Add item for sale'; dlg.appendChild(title);
    dlg.appendChild(fieldBlock('Name', false, textInput(nft.name, 'My juicy thing', function (v) { nft.name = v; })));
    dlg.appendChild(fieldBlock('Image', false, renderImagePicker(nft.imageUri, nft.imageUploading, function (uri, busy) { nft.imageUri = uri; nft.imageUploading = busy; body(); })));
    dlg.appendChild(fieldBlock('Description', true, textArea(nft.description, '', function (v) { nft.description = v; })));
    dlg.appendChild(fieldBlock('Price (ETH)', false, textInput(nft.priceEth, '0.0', function (v) { nft.priceEth = v.trim(); })));
    // Inventory — unlimited by default; uncheck to cap how many can be sold (mirrors the project page).
    dlg.appendChild(toggleRow('Unlimited inventory', '', !nft.limited, function (v) { nft.limited = !v; body(); }));
    if (nft.limited) dlg.appendChild(fieldBlock('Quantity', false, textInput(nft.supply, '100', function (v) { nft.supply = v.trim(); })));
    dlg.appendChild(collapse(nft, 'advOpen', 'Extra options', true, body, function () {
      var c = el('div', '');
      c.appendChild(fieldBlock('Set aside 1 of every N sold', true, textInput(nft.reserveFrequency, '0 = none', function (v) { nft.reserveFrequency = v.trim(); })));
      c.appendChild(fieldBlock('Send set-aside items to', true, textInput(nft.reserveBeneficiary, '0x… address', function (v) { nft.reserveBeneficiary = v.trim(); })));
      c.appendChild(fieldBlock('External link', true, textInput(nft.externalLink, 'https://', function (v) { nft.externalLink = v.trim(); })));
      return c;
    }));
    var foot = el('div', 'create-modal-foot');
    var cancel = el('button', 'create-btn ghost'); cancel.textContent = 'Cancel'; cancel.addEventListener('click', close);
    var ok = el('button', 'create-btn primary'); ok.textContent = existing ? 'Save item' : 'Add item';
    ok.addEventListener('click', function () {
      if (!nft.name) { alert('Name required.'); return; }
      if (!nft.priceEth) { alert('Price required.'); return; }
      if (!nft.imageUri) { alert('Add an image (needs Pinata JWT).'); return; }
      onSave(nft); close();
    });
    foot.appendChild(cancel); foot.appendChild(ok);
    dlg.appendChild(foot);
  }
  body();
  ov.appendChild(dlg);
  document.body.appendChild(ov);
}

// ---------------------------------------------------------------------------
// Deploy orchestration
// ---------------------------------------------------------------------------

function deploy(state, render) {
  state.statusLines = [];
  state.done = false;
  var owner = state.details.immutable
    ? '0x000000000000000000000000000000000000dEaD'
    : ((state.details.owner && /^0x[0-9a-fA-F]{40}$/.test(state.details.owner)) ? state.details.owner : (getAccount && getAccount()));
  if (!owner) {
    connect().then(function () { state.statusLines.push({ text: 'Wallet connected — click Launch again.' }); render(); })
      .catch(function (e) { state.statusLines.push({ text: 'Connect failed: ' + (e && e.message || e), err: true }); render(); });
    return;
  }
  state.deploying = true; render();
  runDeploy(state, owner).then(function () {
    state.deploying = false; state.done = true;
    state.statusLines.push({ text: 'All done. 🎉', ok: true });
    render();
  }).catch(function (e) {
    state.deploying = false;
    state.statusLines.push({ text: 'Error: ' + (e && e.message || e), err: true });
    render();
  });

  function pushStatus(text, kind) { state.statusLines.push({ text: text, ok: kind === 'ok', err: kind === 'err' }); render(); }
  state._push = pushStatus;
}

async function runDeploy(state, owner) {
  var push = state._push;
  // 1) Pin metadata (best-effort).
  var projectUri = '';
  if (hasPinata()) {
    push('Pinning project metadata…');
    try {
      projectUri = await pinJson(buildMetadata(state.details), state.details.name || 'project');
      push('Metadata pinned: ' + projectUri, 'ok');
    } catch (e) { push('Metadata pin failed (' + (e && e.message || e) + ') — launching without it.', 'err'); }
  } else {
    push('No Pinata JWT — launching without metadata; you can edit the project later.');
  }

  var salt = deploySalt(state, owner);

  for (var i = 0; i < state.chainIds.length; i++) {
    var chainId = state.chainIds[i];
    push('Building transaction for ' + chainName(chainId) + '…');
    var plan = buildLaunchArgs(state, chainId, owner, projectUri, salt);
    if (plan.missingSuckers) {
      push('Note: some chain pairs have no sucker deployer on ' + chainName(chainId) + '; those links will be skipped.', 'err');
    }
    if (!plan.address) throw new Error('No deployer address on ' + chainName(chainId));
    push('Confirm in wallet for ' + chainName(chainId) + '…');
    await execTx({ chainId: chainId, address: plan.address, abi: plan.abi, functionName: 'launchProjectFor', args: plan.args,
      onStatus: function (m) { push(m); } });
    push('Launched on ' + chainName(chainId) + ' √', 'ok');
  }
}

function execTx(opts) {
  return new Promise(function (resolve, reject) {
    executeTransaction(Object.assign({}, opts, {
      onSuccess: function (m) { resolve(m); },
      onError: function (m) { reject(new Error(m)); },
    }));
  });
}

// Deterministic salt — same on every chain (so omnichain sucker addresses match). No Math.random.
function deploySalt(state, owner) {
  return keccak256(stringToHex((state.details.name || 'project') + ':' + String(owner).toLowerCase()));
}

// Build the launchProjectFor call for one chain. Returns { contract, address, abi, args, missingSuckers }.
// Used BOTH for the on-chain send (runDeploy) and the JSON payload preview, so what the user reviews is
// byte-for-byte what they sign.
function buildLaunchArgs(state, chainId, owner, projectUri, salt) {
  var multi = state.chainIds.length > 1;
  var hasNfts = state.nfts.length > 0;
  var terminalConfigs = buildTerminalConfigs(chainId, state.accepts, state.swapRouter);
  var effectiveStages = stagesWithStandby(state.stages);
  var stageRulesets = function (payHook) {
    return buildRulesetConfigs(
      effectiveStages.map(function (s, i) { return assembleRuleset(s, chainId, i === 0); }),
      payHook ? { payDataHookVariant: true } : undefined);
  };

  if (!multi && !hasNfts) {
    return {
      contract: 'JBController', address: getAddress('JBController', chainId), abi: launchProjectAbi,
      args: [owner, projectUri, stageRulesets(false), terminalConfigs, ''],
    };
  }
  if (!multi && hasNfts) {
    return {
      contract: 'JB721TiersHookProjectDeployer', address: getAddress('JB721TiersHookProjectDeployer', chainId), abi: deployer721Abi,
      args: [owner, build721Config(state, projectUri),
        { projectUri: projectUri, rulesetConfigurations: stageRulesets(true), terminalConfigurations: terminalConfigs, memo: '' },
        getAddress('JBController', chainId), salt],
    };
  }
  var others = state.chainIds.filter(function (x) { return x !== chainId; });
  var sucker = suckerConfigFor(chainId, others, salt);
  var rulesetsFull = stageRulesets(false);
  var addr = getAddress('JBOmnichainDeployer', chainId);
  var missing = sucker.deployerConfigurations.length < others.length;
  if (hasNfts) {
    var deploy721 = { deployTiersHookConfig: build721Config(state, projectUri), useDataHookForCashOut: false, salt: salt };
    return { contract: 'JBOmnichainDeployer', address: addr, abi: omnichain721Abi, missingSuckers: missing,
      args: [owner, projectUri, deploy721, rulesetsFull, terminalConfigs, '', sucker] };
  }
  return { contract: 'JBOmnichainDeployer', address: addr, abi: omnichainAbi, missingSuckers: missing,
    args: [owner, projectUri, rulesetsFull, terminalConfigs, '', sucker] };
}

// Assemble a single ruleset state object (createDefaultRuleset shape) from the wizard steps.
// Build one JBRulesetConfig from a stage. isFirst => stage 1 (honors scheduled launch); later stages
// queue with mustStartAtOrAfter 0 so the controller chains them after the previous stage's duration.
function assembleRuleset(stage, chainId, isFirst) {
  var rs = createDefaultRuleset();
  rs.baseCurrency = stage.baseCurrency || 1;
  rs.mustStartAtOrAfter = (isFirst && stage.schedule) ? Number(stage.schedule) : 0;
  rs.durationPreset = -1; rs.durationCustom = String(stage.durationSeconds || 0); // exact seconds via custom path

  var custom = stage.tokenMode === 'custom';
  // Reserved rate = sum of the split-row percentages (each is a % of issuance reserved for that recipient).
  var reservedTotalPct = (stage.reservedRecipients || []).reduce(function (s, x) { return s + (Number(x.percent) || 0); }, 0);
  rs.weight = custom ? (stage.weight || '0') : '0';
  rs.reservedPercent = custom ? Math.min(100, reservedTotalPct) : 0;
  rs.weightCutPercent = custom ? stage.weightCutPercent : 0;
  rs.cashOutTaxRate = (custom && stage.cashOutEnabled) ? stage.cashOutTaxRate : 100; // 100% = cash outs off
  rs.allowOwnerMinting = custom ? stage.allowOwnerMinting : false;
  rs.pauseCreditTransfers = custom ? stage.pauseTransfers : false;

  var dl = DEADLINE_OPTIONS.find(function (d) { return d.key === stage.deadline; });
  rs.approvalHook = (dl && dl.contract && getAddress(dl.contract, chainId)) || ZERO;

  rs.pausePay = stage.pausePay; rs.holdFees = stage.holdFees;
  rs.allowSetTerminals = stage.allowSetTerminals; rs.allowSetController = stage.allowSetController;
  rs.allowTerminalMigration = stage.allowTerminalMigration;

  // Splits
  rs.splitGroups = [];
  if (stage.payoutMode !== 'none' && stage.payoutRecipients.length) {
    var total = stage.payoutRecipients.reduce(function (s, x) { return s + (Number(x.amountEth) || 0); }, 0) || 1;
    rs.splitGroups.push({
      groupId: uint256FromAddress(NATIVE_TOKEN),
      splits: stage.payoutRecipients.map(function (x) { return splitState(x, Math.round(((Number(x.amountEth) || 0) / total) * SPLITS_TOTAL)); }),
    });
  }
  if (custom && reservedTotalPct > 0) {
    // Each recipient's share of the reserved group = its row % ÷ the total reserved %.
    rs.splitGroups.push({
      groupId: '1',
      splits: stage.reservedRecipients.filter(function (x) { return (Number(x.percent) || 0) > 0; })
        .map(function (x) { return splitState(x, Math.round((Number(x.percent) || 0) / reservedTotalPct * SPLITS_TOTAL)); }),
    });
  }

  // Fund access (payout limits + surplus allowance). One group on the native terminal carries both.
  rs.fundAccessLimitGroups = [];
  var payoutLimits = [];
  if (stage.payoutMode !== 'none') {
    var amount = stage.payoutMode === 'unlimited' ? UINT224_MAX
      : stage.payoutRecipients.reduce(function (s, x) { return s + safeParseEther(x.amountEth); }, 0n);
    payoutLimits.push({ amount: amount, currency: stage.payoutCurrency || 1 });
  }
  var surplusAllowances = [];
  if (stage.surplusAllowanceOn) {
    var saAmt = stage.surplusAllowanceUnlimited ? UINT224_MAX : safeParseEther(stage.surplusAllowanceAmount);
    if (saAmt > 0n) surplusAllowances.push({ amount: saAmt, currency: stage.surplusAllowanceCurrency || 1 });
  }
  if (payoutLimits.length || surplusAllowances.length) {
    rs.fundAccessLimitGroups.push({
      terminal: getAddress('JBMultiTerminal', chainId), token: NATIVE_TOKEN,
      payoutLimits: payoutLimits, surplusAllowances: surplusAllowances,
    });
  }
  return rs;
}

function splitState(rec, rawPercent) {
  return {
    preferAddToBalance: false,
    percent: rawPercent,
    projectId: rec.type === 'project' ? (Number(rec.projectId) || 0) : 0,
    beneficiary: (rec.address && /^0x[0-9a-fA-F]{40}$/.test(rec.address)) ? rec.address : ZERO,
    lockedUntil: rec.lockedUntil ? Number(rec.lockedUntil) : 0,
    hook: ZERO,
  };
}

function build721Config(state, projectUri) {
  var name = (state.details.name || 'Project') + ' NFTs';
  var symbol = (state.details.name || 'NFT').replace(/[^A-Za-z0-9]/g, '').slice(0, 6).toUpperCase() || 'NFT';
  var tiers = state.nfts.map(function (nft) {
    return {
      price: safeParseEther(nft.priceEth),
      initialSupply: nft.limited ? (Number(nft.supply) || 0) : 4294967295, // uint32 max ~ unlimited
      votingUnits: 0,
      reserveFrequency: Number(nft.reserveFrequency) || 0,
      reserveBeneficiary: (nft.reserveBeneficiary && /^0x[0-9a-fA-F]{40}$/.test(nft.reserveBeneficiary)) ? nft.reserveBeneficiary : ZERO,
      encodedIpfsUri: nft.imageUri ? encodeIpfsUriToBytes32(nft.imageUri) : '0x' + '0'.repeat(64),
      category: 0,
      discountPercent: 0,
      flags: {
        allowOwnerMint: false,
        useReserveBeneficiaryAsDefault: !!(nft.reserveBeneficiary && nft.reserveFrequency),
        transfersPausable: false, useVotingUnits: false, cantBeRemoved: false,
        cantIncreaseDiscountPercent: false, cantBuyWithCredits: false,
      },
      splitPercent: 0,
      splits: [],
    };
  });
  return {
    name: name, symbol: symbol, baseUri: 'ipfs://', tokenUriResolver: ZERO, contractUri: projectUri || '',
    tiersConfig: { tiers: tiers, currency: (state.stages[0] && state.stages[0].baseCurrency) || 1, decimals: 18 },
    flags: { noNewTiersWithReserves: false, noNewTiersWithVotes: false, noNewTiersWithOwnerMinting: false, preventOverspending: false, issueTokensForSplits: false },
  };
}

// Terminal configs: the project's accounting terminal (which token[s] it HOLDS, currency =
// uint32(uint160(token))) plus, optionally, the router terminal (empty contexts — it swaps any incoming
// token into the accounting token[s], like REVDeployer does).
function buildTerminalConfigs(chainId, accepts, swapRouter) {
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal) return [];
  var contexts = [];
  if (accepts.indexOf('eth') !== -1) {
    contexts.push({ token: NATIVE_TOKEN, decimals: 18, currency: Number(uint32FromAddress(NATIVE_TOKEN)) });
  }
  if (accepts.indexOf('usdc') !== -1 && USDC_BY_CHAIN[chainId]) {
    var usdc = USDC_BY_CHAIN[chainId];
    contexts.push({ token: usdc, decimals: 6, currency: Number(uint32FromAddress(usdc)) });
  }
  if (!contexts.length) contexts.push({ token: NATIVE_TOKEN, decimals: 18, currency: Number(uint32FromAddress(NATIVE_TOKEN)) });
  var configs = [{ terminal: terminal, accountingContextsToAccept: contexts }];
  if (swapRouter) {
    var router = getAddress('JBRouterTerminalRegistry', chainId);
    if (router) configs.push({ terminal: router, accountingContextsToAccept: [] });
  }
  return configs;
}

function buildMetadata(d) {
  var m = { version: 1, name: d.name || '', projectTagline: d.tagline || '', description: d.description || '' };
  if (d.logoUri) m.logoUri = d.logoUri;
  if (d.coverImageUri) m.coverImageUri = d.coverImageUri;
  if (d.website) m.infoUri = d.website;
  if (d.twitter) m.twitter = d.twitter.replace(/^@/, '');
  if (d.discord) m.discord = d.discord;
  if (d.telegram) m.telegram = d.telegram;
  if (d.payDisclosure) m.payDisclosure = d.payDisclosure;
  if (d.tags && d.tags.length) m.tags = d.tags;
  return m;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function networkOf(id) { var c = CHAIN_OPTIONS.find(function (x) { return x.id === id; }); return c && c.testnet ? 'testnet' : 'mainnet'; }
function chainName(id) { var c = CHAIN_OPTIONS.find(function (x) { return x.id === id; }); return c ? c.name : ('chain ' + id); }
function shortAddr(a) { return a && a.length > 10 ? (a.slice(0, 6) + '…' + a.slice(-4)) : (a || '—'); }
function secondsLabel(s) {
  var p = DURATION_PRESETS.find(function (x) { return x.seconds === s; });
  if (p) return p.label;
  var U = [['year', 31536000], ['week', 604800], ['day', 86400], ['hour', 3600]];
  for (var i = 0; i < U.length; i++) { if (s % U[i][1] === 0) { var n = s / U[i][1]; return n + ' ' + U[i][0] + (n === 1 ? '' : 's'); } }
  return s + 's';
}
var DURATION_UNIT_SECONDS = { hours: 3600, days: 86400, weeks: 604800, years: 31536000 };
function recomputeCustomDuration(stage) {
  var v = parseFloat(stage.customDurVal);
  stage.durationSeconds = (v > 0) ? Math.round(v * (DURATION_UNIT_SECONDS[stage.customDurUnit] || 86400)) : 0;
}
function uint256FromAddress(addr) { return BigInt(addr).toString(); }
function uint32FromAddress(addr) { return (BigInt(addr) & 0xFFFFFFFFn).toString(); }
function safeParseEther(v) { try { return v ? parseEther(String(v)) : 0n; } catch (_) { return 0n; } }
function ipfsHttp(uri) {
  if (!uri) return '';
  if (uri.indexOf('ipfs://') === 0) return 'https://jbm.infura-ipfs.io/ipfs/' + uri.slice(7);
  return uri;
}
function tsToLocal(ts) {
  var d = new Date(Number(ts) * 1000); if (isNaN(d.getTime())) return '';
  var p = function (x) { return x < 10 ? '0' + x : '' + x; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// e.g. "America/New_York" — the browser's local zone, for the scheduled-launch helper text.
function localTimezoneLabel() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; }
}
