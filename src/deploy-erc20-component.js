// src/deploy-erc20-component.js
// Deploy ERC-20 component
// Flow: Project ID -> chain -> name -> symbol -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createWalletButton, discoverChains, selectChain, firstChainForNetwork,
  executeTransaction, renderError, getAddress,
  getChainTokens, parseHashDefaults,
} from './component-base.js';

export var deployERC20Abi = [{
  type: 'function', name: 'deployERC20For', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'name', type: 'string' },
    { name: 'symbol', type: 'string' },
    { name: 'salt', type: 'bytes32' },
  ],
  outputs: [{ name: '', type: 'address' }],
}];

// Pure builder for JBController.deployERC20For. `o`: { chainId, controllerAddr, projectId, name, symbol, salt (bytes32) }.
export function buildDeployErc20Args(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: deployERC20Abi, functionName: 'deployERC20For',
    args: [BigInt(o.projectId), o.name, o.symbol, o.salt],
  };
}

export function renderDeployERC20Component() {
  var defaults = parseHashDefaults('deploy-erc20');

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : 1,
    network: defaults.network || 'mainnet',
    tokens: getChainTokens(defaults.chain ? Number(defaults.chain) : 1),
    selectedToken: getChainTokens(defaults.chain ? Number(defaults.chain) : 1)[0] || null,
    decimals: 18,
    tokenName: defaults.name || '',
    tokenSymbol: defaults.symbol || '',
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;

  var comp = createComponentWrapper('DEPLOY ERC-20', 'deploy-erc20', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.tokenName) params.name = state.tokenName;
    if (state.tokenSymbol) params.symbol = state.tokenSymbol;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Requires project owner or DEPLOY_ERC20 permission.' });
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


    // Token name
    var nameSection = el('div', 'component-section');
    var nameLabel = el('label', 'input-label');
    nameLabel.textContent = 'token name';
    nameSection.appendChild(nameLabel);
    var nameInput = el('input', 'field string-field');
    nameInput.type = 'text';
    nameInput.placeholder = 'My Project Token';
    nameInput.value = state.tokenName;
    nameInput.addEventListener('input', function() { state.tokenName = nameInput.value; });
    nameSection.appendChild(nameInput);
    body.appendChild(nameSection);

    // Token symbol
    var symSection = el('div', 'component-section');
    var symLabel = el('label', 'input-label');
    symLabel.textContent = 'token symbol';
    symSection.appendChild(symLabel);
    var symInput = el('input', 'field string-field');
    symInput.type = 'text';
    symInput.placeholder = 'MPT';
    symInput.value = state.tokenSymbol;
    symInput.addEventListener('input', function() { state.tokenSymbol = symInput.value; });
    symSection.appendChild(symInput);
    body.appendChild(symSection);

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('DEPLOY', executeDeploy, comp.permissionNote));
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

  function executeDeploy() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.projectId) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }
    if (!state.tokenName.trim()) { state.error = 'Enter a token name'; updateUI(); return; }
    if (!state.tokenSymbol.trim()) { state.error = 'Enter a token symbol'; updateUI(); return; }

    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    var salt = '0x0000000000000000000000000000000000000000000000000000000000000000';

    executeTransaction({
      ...buildDeployErc20Args({ chainId: state.selectedChain, controllerAddr: controllerAddr, projectId: state.projectId, name: state.tokenName.trim(), symbol: state.tokenSymbol.trim(), salt: salt }),
      confirmSummary: { action: 'Deploy ERC-20 token', rows: [
        ['Name', state.tokenName.trim()],
        ['Symbol', state.tokenSymbol.trim()],
        ['Project', '#' + String(state.projectId)],
        ['One-time', 'a project can deploy its token once'],
      ] },
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
