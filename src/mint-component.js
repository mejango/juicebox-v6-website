// src/mint-component.js
// Mint Tokens component
// Flow: Project ID -> chain -> token count -> beneficiary -> memo -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createBeneficiaryInput, createWalletButton, discoverChains, selectChain,
  firstChainForNetwork, executeTransaction, renderError, getAddress,
  getChainTokens, parseAmount, parseHashDefaults, getBeneficiaryAddress,
} from './component-base.js';

export var mintTokensAbi = [{
  type: 'function', name: 'mintTokensOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'tokenCount', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'memo', type: 'string' },
    { name: 'useReservedPercent', type: 'bool' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];

// Pure builder for JBController.mintTokensOf. `o`: { chainId, controllerAddr, projectId, tokenCount (bigint),
// beneficiary, memo, useReservedPercent (bool) }.
export function buildMintArgs(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: mintTokensAbi, functionName: 'mintTokensOf',
    args: [BigInt(o.projectId), o.tokenCount, o.beneficiary, o.memo || '', !!o.useReservedPercent],
  };
}

export function renderMintComponent() {
  var defaults = parseHashDefaults('mint');

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : 1,
    network: defaults.network || 'mainnet',
    tokens: getChainTokens(defaults.chain ? Number(defaults.chain) : 1),
    selectedToken: getChainTokens(defaults.chain ? Number(defaults.chain) : 1)[0] || null,
    decimals: 18,
    amount: defaults.amount || '',
    beneficiary: defaults.beneficiary ? 'custom' : 'self',
    customBeneficiary: defaults.beneficiary || '',
    memo: defaults.memo || '',
    useReservedPercent: false,
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;

  var comp = createComponentWrapper('MINT TOKENS', 'mint', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.amount) params.amount = state.amount;
    if (state.beneficiary === 'custom' && state.customBeneficiary) params.beneficiary = state.customBeneficiary;
    if (state.memo) params.memo = state.memo;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Requires project owner or MINT_TOKENS permission. Ruleset must allow owner minting.' });
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


    // Token count (always 18 decimals)
    var amtSection = el('div', 'component-section');
    var amtLabel = el('label', 'input-label');
    amtLabel.innerHTML = 'token count <span class="type-hint">18 decimals</span>';
    amtSection.appendChild(amtLabel);
    var amtInput = el('input', 'field numeric-field');
    amtInput.type = 'text';
    amtInput.placeholder = '1000';
    amtInput.value = state.amount;
    amtInput.addEventListener('input', function() { state.amount = amtInput.value.trim(); });
    amtSection.appendChild(amtInput);
    body.appendChild(amtSection);

    // Beneficiary
    body.appendChild(createBeneficiaryInput(state, function() { updateUI(); }));

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

    // useReservedPercent toggle
    var reservedSection = el('div', 'component-section');
    var reservedLabel = el('label', 'input-label');
    reservedLabel.style.display = 'flex';
    reservedLabel.style.alignItems = 'center';
    reservedLabel.style.gap = '6px';
    var checkbox = el('input', '');
    checkbox.type = 'checkbox';
    checkbox.checked = state.useReservedPercent;
    checkbox.addEventListener('change', function() { state.useReservedPercent = checkbox.checked; });
    reservedLabel.appendChild(checkbox);
    reservedLabel.appendChild(document.createTextNode('Apply reserved percent'));
    reservedSection.appendChild(reservedLabel);
    body.appendChild(reservedSection);

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('MINT', executeMint, comp.permissionNote));
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

  function executeMint() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.projectId) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }
    if (!state.amount) { state.error = 'Enter a token count'; updateUI(); return; }

    var tokenCount;
    try { tokenCount = parseAmount(state.amount, 18); } catch (_) {
      state.error = 'Invalid token count'; updateUI(); return;
    }
    if (tokenCount <= 0n) { state.error = 'Enter a token count above zero'; updateUI(); return; }

    var beneficiary = getBeneficiaryAddress(state);
    if (!beneficiary) {
      state.error = state.beneficiary === 'custom' ? 'Enter a valid beneficiary address' : 'Connect wallet first';
      updateUI(); return;
    }

    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    executeTransaction({
      ...buildMintArgs({ chainId: state.selectedChain, controllerAddr: controllerAddr, projectId: state.projectId, tokenCount: tokenCount, beneficiary: beneficiary, memo: state.memo || '', useReservedPercent: state.useReservedPercent }),
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
