// src/queue-ruleset-component.js
// Queue Ruleset component — queues new rulesets for an existing project
// Flow: project ID -> chain -> ruleset config(s) -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createWalletButton, discoverChains, selectChain, firstChainForNetwork,
  executeTransaction, renderError, getAddress, parseHashDefaults,
  createPublicClientForChain, getChainTokens,
} from './component-base.js';
import { createDefaultRuleset, buildRulesetConfigs } from './ruleset-config.js';
import { renderRulesetFieldset } from './ruleset-ui.js';
import { requiredFeedPairs, verifyFeedCoverage, feedCurrencyLabel } from './create-flow.js';

var accountingContextsAbi = [{
  type: 'function', name: 'accountingContextsOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ type: 'tuple[]', components: [
    { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint8' }, { name: 'currency', type: 'uint32' },
  ] }],
}];

// A queued ruleset can repoint baseCurrency while the project's accounting contexts stay immutable —
// block a base whose (context ↔ base) JBPrices pair is unreachable, since payments in that context
// would revert under the new rules. Cross-context pairs are not probed: the queue can't change them,
// and blocking on them would also block a rescue queue (allowAddPriceFeed) on an affected project.
function verifyQueueFeedCoverage(chainId, projectId, rulesetConfigs) {
  var terminal = getAddress('JBMultiTerminal', chainId);
  if (!terminal) return Promise.resolve(); // no canonical terminal → no contexts to convert
  var bases = [];
  rulesetConfigs.forEach(function (cfg) {
    var cur = Number(cfg.metadata && cfg.metadata.baseCurrency) || 1;
    if (bases.indexOf(cur) === -1) bases.push(cur);
  });
  return createPublicClientForChain(chainId)
    .readContract({ address: terminal, abi: accountingContextsAbi, functionName: 'accountingContextsOf', args: [BigInt(projectId)] })
    .catch(function () { throw new Error('Couldn’t verify price feed coverage right now — nothing was sent. Try again.'); })
    .then(function (ctxs) {
      var known = getChainTokens(chainId);
      var labeled = (ctxs || []).map(function (ctx) {
        var match = known.find(function (t) { return t.address.toLowerCase() === String(ctx.token).toLowerCase(); });
        return { token: ctx.token, currency: ctx.currency, symbol: match ? match.symbol.replace(' (native)', '') : null };
      });
      var pairs = requiredFeedPairs(labeled, bases, true);
      return verifyFeedCoverage(chainId, pairs, function (cur) { return feedCurrencyLabel(cur, labeled); }, { projectId: BigInt(projectId) });
    });
}

export var queueRulesetsAbi = [{
  type: 'function', name: 'queueRulesetsOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
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
          // Canonical JBSplit field order — must match exactly or the tuple type changes the 4-byte selector
          // and every queue tx reverts (preferAddToBalance was wrongly at index 0).
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
    { name: 'memo', type: 'string' },
  ],
  outputs: [{ name: 'rulesetId', type: 'uint256' }],
}];

// Pure builder for JBController.queueRulesetsOf. `o`: { chainId, controllerAddr, projectId, rulesetConfigs
// (array of ruleset tuples, built by buildRulesetConfigs), memo }.
export function buildQueueRulesetsArgs(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: queueRulesetsAbi, functionName: 'queueRulesetsOf',
    args: [BigInt(o.projectId), o.rulesetConfigs, o.memo || ''],
  };
}

export function renderQueueRulesetComponent() {
  var defaults = parseHashDefaults('queue-ruleset');

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : null,
    network: defaults.network || 'mainnet',
    tokens: [],
    selectedToken: null,
    decimals: 18,
    rulesets: [createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '' })],
    memo: '',
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;

  var comp = createComponentWrapper('QUEUE RULESET', 'queue-ruleset', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Requires project owner or QUEUE_RULESETS permission.', wide: true });

  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';
    body.appendChild(createProjectAndChainInput(state, scheduleDiscovery, function(cid) {
      if (cid === null) cid = firstChainForNetwork(state);
      if (cid) selectChain(state, cid);
      state.txStatus = null;
      updateUI();
    }));

    // Rulesets
    for (var ri = 0; ri < state.rulesets.length; ri++) {
      var rs = state.rulesets[ri];
      body.appendChild(renderRulesetFieldset(rs, ri, state, updateUI, {
        includeStartAt: true,
        weightHint: 'tokens per ' + (Number(rs.baseCurrency) === 2 ? 'USD' : 'ETH') + ', blank = inherit previous, 0 = no issuance',
        weightPlaceholder: 'inherit',
      }));
    }

    // Add ruleset button — queue another ruleset after this one.
    var addBtn = el('button', 'add-ruleset-btn');
    addBtn.type = 'button';
    addBtn.textContent = '+ ruleset';
    addBtn.addEventListener('click', function() {
      state.rulesets.push(createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '' }));
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

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('QUEUE RULESET', executeQueue, comp.permissionNote));
  }

  function scheduleDiscovery() {
    state.liveChains = [];
    state.selectedChain = null;
    state.error = null;
    state.txStatus = null;

    var pid = state.projectId;
    if (!pid || !/^\d+$/.test(pid) || pid === '0') { state.phase = 'idle'; updateUI(); return; }

    state.phase = 'discovering';
    updateUI();

    var gen = ++discoveryGeneration;
    discoverChains(pid, function(live) {
      if (gen !== discoveryGeneration) return;
      state.liveChains = live;
      if (!live.length) { state.phase = 'idle'; state.error = 'Project not found on a reachable supported chain.'; updateUI(); return; }
      var preferred = (state._defaultChain && live.indexOf(state._defaultChain) !== -1) ? state._defaultChain : firstChainForNetwork(state) || live[0];
      selectChain(state, preferred);
      state._defaultChain = null;
      state.phase = 'ready';
      updateUI();
    });
  }

  function executeQueue() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.projectId) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }

    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    var rulesetConfigs;
    try {
      rulesetConfigs = buildRulesetConfigs(state.rulesets);
    } catch (err) {
      state.error = (err && err.message) || String(err); updateUI(); return;
    }

    state.txStatus = { message: 'Verifying price feed coverage…', success: false };
    updateUI();
    verifyQueueFeedCoverage(state.selectedChain, state.projectId, rulesetConfigs).then(function() {
      executeTransaction({
        ...buildQueueRulesetsArgs({ chainId: state.selectedChain, controllerAddr: controllerAddr, projectId: state.projectId, rulesetConfigs: rulesetConfigs, memo: state.memo || '' }),
        onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
        onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; updateUI(); },
        onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
      });
    }, function(err) {
      state.error = (err && err.message) || String(err);
      state.txStatus = null;
      updateUI();
    });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
