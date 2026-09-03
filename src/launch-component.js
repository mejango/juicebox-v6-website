// src/launch-component.js
// Launch Project component — creates a project then launches its first rulesets
// Flow: project URI -> ruleset config(s) -> terminal config -> execute

import {
  el, createComponentWrapper, createWalletButton, executeTransaction, executeRead,
  renderError, getAddress, getAccount, NATIVE_TOKEN, formatAmount,
} from './component-base.js';
import { createDefaultRuleset, buildRulesetConfigs } from './ruleset-config.js';
import { renderRulesetFieldset } from './ruleset-ui.js';
export {
  parseRulesetWeight,
  createDefaultSplit,
  createDefaultSplitGroup,
  createDefaultPayoutLimit,
  createDefaultSurplusAllowance,
  createDefaultFundAccessLimitGroup,
  createDefaultRuleset,
  buildRulesetConfigs,
  buildSplitGroups,
  buildFundAccessLimitGroups,
  getDurationSeconds,
} from './ruleset-config.js';
export { percentSlider, configRow } from './ruleset-ui.js';

export var launchProjectAbi = [{
  type: 'function', name: 'launchProjectFor', stateMutability: 'payable',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'projectUri', type: 'string' },
    { name: 'rulesetConfigurations', type: 'tuple[]', components: [
      { name: 'mustStartAtOrAfter', type: 'uint48' },
      { name: 'duration', type: 'uint32' },
      { name: 'weight', type: 'uint112' },
      { name: 'weightCutPercent', type: 'uint32' },
      { name: 'approvalHook', type: 'address' },
      { name: 'metadata', type: 'tuple', components: [
        { name: 'reservedPercent', type: 'uint16' },
        { name: 'cashOutTaxRate', type: 'uint16' },
        { name: 'baseCurrency', type: 'uint32' },
        { name: 'pausePay', type: 'bool' },
        { name: 'pauseCreditTransfers', type: 'bool' },
        { name: 'allowOwnerMinting', type: 'bool' },
        { name: 'allowSetCustomToken', type: 'bool' },
        { name: 'allowTerminalMigration', type: 'bool' },
        { name: 'allowSetTerminals', type: 'bool' },
        { name: 'allowSetController', type: 'bool' },
        { name: 'allowAddAccountingContext', type: 'bool' },
        { name: 'allowAddPriceFeed', type: 'bool' },
        { name: 'ownerMustSendPayouts', type: 'bool' },
        { name: 'holdFees', type: 'bool' },
        { name: 'scopeCashOutsToLocalBalances', type: 'bool' },
        { name: 'useDataHookForPay', type: 'bool' },
        { name: 'useDataHookForCashOut', type: 'bool' },
        { name: 'dataHook', type: 'address' },
        { name: 'metadata', type: 'uint16' },
      ]},
      { name: 'splitGroups', type: 'tuple[]', components: [
        { name: 'groupId', type: 'uint256' },
        { name: 'splits', type: 'tuple[]', components: [
          { name: 'percent', type: 'uint32' },
          { name: 'projectId', type: 'uint64' },
          { name: 'beneficiary', type: 'address' },
          { name: 'preferAddToBalance', type: 'bool' },
          { name: 'lockedUntil', type: 'uint48' },
          { name: 'hook', type: 'address' },
        ]},
      ]},
      { name: 'fundAccessLimitGroups', type: 'tuple[]', components: [
        { name: 'terminal', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'payoutLimits', type: 'tuple[]', components: [
          { name: 'amount', type: 'uint224' },
          { name: 'currency', type: 'uint32' },
        ]},
        { name: 'surplusAllowances', type: 'tuple[]', components: [
          { name: 'amount', type: 'uint224' },
          { name: 'currency', type: 'uint32' },
        ]},
      ]},
    ]},
    { name: 'terminalConfigurations', type: 'tuple[]', components: [
      { name: 'terminal', type: 'address' },
      { name: 'accountingContextsToAccept', type: 'tuple[]', components: [
        { name: 'token', type: 'address' },
        { name: 'decimals', type: 'uint8' },
        { name: 'currency', type: 'uint32' },
      ]},
    ]},
    { name: 'memo', type: 'string' },
  ],
  outputs: [{ name: 'projectId', type: 'uint256' }],
}];

var CHAIN_OPTIONS = [
  { id: 1, name: 'Ethereum', testnet: false }, { id: 10, name: 'Optimism', testnet: false },
  { id: 42161, name: 'Arbitrum', testnet: false }, { id: 8453, name: 'Base', testnet: false },
  { id: 11155111, name: 'Sepolia', testnet: true }, { id: 11155420, name: 'OP Sepolia', testnet: true },
  { id: 84532, name: 'Base Sepolia', testnet: true }, { id: 421614, name: 'Arb Sepolia', testnet: true },
];

export function renderLaunchComponent() {
  var state = {
    chainIds: [1],
    projectUri: '',
    rulesets: [createDefaultRuleset()],
    memo: '',
    error: null,
    txStatus: null,
  };

  var comp = createComponentWrapper('LAUNCH PROJECT', 'launch', state, function() {
    var params = {};
    if (state.chainIds && state.chainIds.length) params.chains = state.chainIds.join(',');
    return params;
  }, { permissionNote: 'Creates a new project owned by the connected wallet and launches its first ruleset.', wide: true });

  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';

    // Project URI
    var uriSection = el('div', 'component-section');
    var uriLabel = el('label', 'input-label');
    uriLabel.innerHTML = 'project URI <span class="type-hint">optional, IPFS hash</span>';
    uriSection.appendChild(uriLabel);
    var uriInput = el('input', 'field string-field optional-field');
    uriInput.type = 'text';
    uriInput.placeholder = 'ipfs://...';
    uriInput.value = state.projectUri;
    uriInput.addEventListener('input', function() { state.projectUri = uriInput.value; });
    uriSection.appendChild(uriInput);
    body.appendChild(uriSection);

    // Rulesets
    for (var ri = 0; ri < state.rulesets.length; ri++) {
      var rs = state.rulesets[ri];
      body.appendChild(renderRulesetFieldset(rs, ri, state, updateUI, {
        // Launch has no previous ruleset to inherit from — blank encodes an explicit 0 (no issuance).
        weightHint: 'tokens per ' + (Number(rs.baseCurrency) === 2 ? 'USD' : 'ETH') + ', blank or 0 = no issuance',
      }));
    }

    // Add ruleset button — queue another ruleset after this one.
    var addBtn = el('button', 'add-ruleset-btn');
    addBtn.type = 'button';
    addBtn.textContent = '+ ruleset';
    addBtn.addEventListener('click', function() {
      state.rulesets.push(createDefaultRuleset());
      updateUI();
    });
    body.appendChild(addBtn);

    // Memo
    var memoSection = el('div', 'component-section');
    var memoLabel = el('label', 'input-label');
    memoLabel.innerHTML = 'memo <span class="type-hint">optional</span>';
    memoSection.appendChild(memoLabel);
    var memoInput = el('input', 'field string-field optional-field');
    memoInput.type = 'text';
    memoInput.placeholder = 'Add a memo (optional)';
    memoInput.value = state.memo;
    memoInput.addEventListener('input', function() { state.memo = memoInput.value; });
    memoSection.appendChild(memoInput);
    body.appendChild(memoSection);

    // Chain — single-select; this widget launches on ONE chain (the create wizard owns omnichain).
    body.appendChild(renderChainPicker(state, updateUI));

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('LAUNCH', executeLaunch, comp.permissionNote));
  }

  async function executeLaunch() {
    state.error = null;
    state.txStatus = null;

    var owner = getAccount();
    if (!owner) { state.error = 'Connect wallet first'; updateUI(); return; }

    var controllerAddr = getAddress('JBController', state.chainIds[0]);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    // launchProjectFor charges msg.value == JBProjects.creationFee() — omitting it reverts on fee chains.
    var creationFee = 0n;
    try {
      var projectsAddr = getAddress('JBProjects', state.chainIds[0]);
      if (projectsAddr) creationFee = await executeRead({
        chainId: state.chainIds[0], address: projectsAddr, functionName: 'creationFee', args: [],
        abi: [{ type: 'function', name: 'creationFee', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      });
    } catch (_) {}

    var terminalAddr = getAddress('JBMultiTerminal', state.chainIds[0]);

    var rulesetConfigs;
    try {
      rulesetConfigs = buildRulesetConfigs(state.rulesets, { weightMode: 'launch' });
    } catch (err) {
      state.error = (err && err.message) || String(err); updateUI(); return;
    }

    // Default terminal config: accept native ETH
    var terminalConfigs = [];
    if (terminalAddr) {
      var ethCurrency = Number(BigInt(NATIVE_TOKEN) & 0xFFFFFFFFn);
      terminalConfigs.push({
        terminal: terminalAddr,
        accountingContextsToAccept: [{
          token: NATIVE_TOKEN,
          decimals: 18,
          currency: ethCurrency,
        }],
      });
    }

    executeTransaction({
      chainId: state.chainIds[0],
      address: controllerAddr,
      abi: launchProjectAbi,
      functionName: 'launchProjectFor',
      args: [owner, state.projectUri || '', rulesetConfigs, terminalConfigs, state.memo || ''],
      value: creationFee,
      confirmSummary: { action: 'Launch project', rows: [
        ['Owner', owner],
        ['Rulesets', String(rulesetConfigs.length)],
        ['Accepts', terminalAddr ? 'ETH through JBMultiTerminal' : 'no terminal yet'],
        ['Creation fee', formatAmount(creationFee || 0n, 18) + ' ETH'],
      ] },
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  return wrapper;
}

// Single-chain picker — the widget executes ONE launchProjectFor on ONE chain, so the pills have
// radio semantics (picking a chain replaces the selection). Mirrors the look of
// `createProjectAndChainInput`: a small mainnet/testnet `<select>` inline with chain pills.
// Switching the network resets the chain selection to a sensible default on the new side.
// Omnichain launches belong to the create wizard, not this widget.
function renderChainPicker(state, updateUI) {
  var section = el('div', 'component-section chain-multi-section');
  var label = el('label', 'input-label');
  label.innerHTML = 'chain <span class="type-hint">pick a chain</span>';
  section.appendChild(label);

  function networkOf(id) {
    var c = CHAIN_OPTIONS.find(function(x) { return x.id === id; });
    return c && c.testnet ? 'testnet' : 'mainnet';
  }
  if (!state.chainIds || state.chainIds.length === 0) state.chainIds = [1];
  var currentNetwork = networkOf(state.chainIds[0]);
  var isTestnet = currentNetwork === 'testnet';

  var row = el('div', 'chain-multi-row');

  var netSelect = el('select', 'network-dropdown');
  ['mainnet', 'testnet'].forEach(function(net) {
    var opt = document.createElement('option');
    opt.value = net;
    opt.textContent = net;
    if (currentNetwork === net) opt.selected = true;
    netSelect.appendChild(opt);
  });
  netSelect.addEventListener('change', function() {
    var newNet = netSelect.value;
    if (newNet === currentNetwork) return;
    var firstOnNet = CHAIN_OPTIONS.find(function(c) { return (newNet === 'testnet') === c.testnet; });
    state.chainIds = firstOnNet ? [firstOnNet.id] : [];
    updateUI();
  });
  row.appendChild(netSelect);

  CHAIN_OPTIONS.filter(function(c) { return c.testnet === isTestnet; }).forEach(function(c) {
    var selected = state.chainIds.indexOf(c.id) !== -1;
    var pill = el('button', 'chain-pill' + (c.testnet ? ' testnet' : '') + (selected ? ' selected' : ''));
    pill.type = 'button';
    pill.textContent = c.name;
    pill.addEventListener('click', function() {
      state.chainIds = [c.id]; // radio semantics: exactly one chain — the one the launch executes on
      updateUI();
    });
    row.appendChild(pill);
  });
  section.appendChild(row);

  return section;
}
