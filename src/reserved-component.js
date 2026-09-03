// src/reserved-component.js
// Distribute Reserved Tokens component
// Flow: Project ID -> chain -> show pending amount -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createWalletButton, discoverChains, selectChain, firstChainForNetwork,
  executeTransaction, executeRead, renderError, getAddress,
  getChainTokens, formatAmount, parseHashDefaults,
} from './component-base.js';

export var sendReservedAbi = [{
  type: 'function', name: 'sendReservedTokensToSplitsOf', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}];

// Pure builder for JBController.sendReservedTokensToSplitsOf. `o`: { chainId, controllerAddr, projectId }.
export function buildSendReservedArgs(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: sendReservedAbi, functionName: 'sendReservedTokensToSplitsOf',
    args: [BigInt(o.projectId)],
  };
}

var pendingReservedAbi = [{
  type: 'function', name: 'pendingReservedTokenBalanceOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ name: '', type: 'uint256' }],
}];

export function renderReservedComponent() {
  var defaults = parseHashDefaults('reserved');

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : 1,
    network: defaults.network || 'mainnet',
    tokens: getChainTokens(defaults.chain ? Number(defaults.chain) : 1),
    selectedToken: getChainTokens(defaults.chain ? Number(defaults.chain) : 1)[0] || null,
    decimals: 18,
    pendingAmount: null,
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;

  var comp = createComponentWrapper('DISTRIBUTE RESERVED', 'reserved', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Permissionless. Anyone can trigger distribution of pending reserved tokens to splits.' });
  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';
    body.appendChild(createProjectAndChainInput(state, scheduleDiscovery, function(cid) {
      if (cid === null) cid = firstChainForNetwork(state);
      if (cid) selectChain(state, cid);
      state.pendingAmount = null;
      state.txStatus = null;
      updateUI();
      loadPending();
    }));


    // Pending amount display
    if (state.pendingAmount !== null) {
      var infoBox = el('div', 'pay-preview');
      var row = el('div', 'preview-row');
      var lbl = el('span', 'preview-label');
      lbl.textContent = 'Pending reserved tokens';
      row.appendChild(lbl);
      var val = el('span', 'preview-value');
      val.textContent = formatAmount(state.pendingAmount, 18);
      row.appendChild(val);
      infoBox.appendChild(row);
      body.appendChild(infoBox);
    }

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('DISTRIBUTE', executeDistribute, comp.permissionNote));
  }

  function scheduleDiscovery() {
    state.liveChains = [];
    state.selectedChain = null;
    state.pendingAmount = null;
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
      loadPending();
    });
  }

  function loadPending() {
    if (!state.selectedChain || !state.projectId) return;
    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) return;

    executeRead({
      chainId: state.selectedChain,
      address: controllerAddr,
      abi: pendingReservedAbi,
      functionName: 'pendingReservedTokenBalanceOf',
      args: [BigInt(state.projectId)],
    }).then(function(result) {
      state.pendingAmount = result;
      updateUI();
    }).catch(function() {});
  }

  function executeDistribute() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.projectId) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }

    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    executeTransaction({
      ...buildSendReservedArgs({ chainId: state.selectedChain, controllerAddr: controllerAddr, projectId: state.projectId }),
      confirmSummary: { action: 'Distribute reserved tokens', rows: [
        ['Sends', 'all pending reserved tokens to the reserved splits'],
        ['Project', '#' + String(state.projectId)],
        ['Who can call', 'anyone — no fee'],
      ] },
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; loadPending(); updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
