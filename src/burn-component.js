// src/burn-component.js
// Burn Tokens component
// Flow: Project ID -> chain -> token count -> memo -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createWalletButton, discoverChains, selectChain, firstChainForNetwork,
  executeTransaction, executeRead, renderError, getAddress, getAccount, getViewAs,
  getChainTokens, parseAmount, formatAmount, parseHashDefaults,
} from './component-base.js';

export var burnTokensAbi = [{
  type: 'function', name: 'burnTokensOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'holder', type: 'address' },
    { name: 'projectId', type: 'uint256' },
    { name: 'tokenCount', type: 'uint256' },
    { name: 'memo', type: 'string' },
  ],
  outputs: [],
}];

// Pure builder for JBController.burnTokensOf. `o`: { chainId, controllerAddr, holder, projectId, tokenCount (bigint), memo }.
export function buildBurnArgs(o) {
  return {
    chainId: o.chainId, address: o.controllerAddr, abi: burnTokensAbi, functionName: 'burnTokensOf',
    args: [o.holder, BigInt(o.projectId), o.tokenCount, o.memo || ''],
  };
}

var totalBalanceOfAbi = [{
  type: 'function', name: 'totalBalanceOf', stateMutability: 'view',
  inputs: [
    { name: 'holder', type: 'address' },
    { name: 'projectId', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];

export function renderBurnComponent() {
  var defaults = parseHashDefaults('burn');

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
    memo: defaults.memo || '',
    balance: null,
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;

  var comp = createComponentWrapper('BURN TOKENS', 'burn', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.amount) params.amount = state.amount;
    if (state.memo) params.memo = state.memo;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Token holder burns their own tokens. Irreversible.' });
  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';
    body.appendChild(createProjectAndChainInput(state, scheduleDiscovery, function(cid) {
      if (cid === null) cid = firstChainForNetwork(state);
      if (cid) selectChain(state, cid);
      state.balance = null;
      state.txStatus = null;
      updateUI();
      loadBalance();
    }));


    // Balance display — always the CONNECTED wallet's balance: the burn spends from the real signer,
    // so showing a View-as account's balance here would misstate what this form can actually burn.
    if (state.balance !== null) {
      var balBox = el('div', 'pay-preview');
      var row = el('div', 'preview-row');
      var lbl = el('span', 'preview-label');
      lbl.textContent = 'Your project token balance';
      row.appendChild(lbl);
      var val = el('span', 'preview-value');
      val.textContent = formatAmount(state.balance, 18);
      row.appendChild(val);
      balBox.appendChild(row);
      if (getViewAs()) {
        var note = el('div', 'preview-note');
        note.textContent = 'View as is active — this is your connected wallet’s balance, the account a burn would spend from.';
        balBox.appendChild(note);
      }
      body.appendChild(balBox);
    }

    // Token count
    var amtSection = el('div', 'component-section');
    var amtLabel = el('label', 'input-label');
    amtLabel.innerHTML = 'token count to burn <span class="type-hint">18 decimals</span>';
    amtSection.appendChild(amtLabel);
    var amtInput = el('input', 'field numeric-field');
    amtInput.type = 'text';
    amtInput.placeholder = '100';
    amtInput.value = state.amount;
    amtInput.addEventListener('input', function() { state.amount = amtInput.value.trim(); });
    amtSection.appendChild(amtInput);
    body.appendChild(amtSection);

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

    // Warning
    var warn = el('div', 'error-box warning');
    warn.textContent = 'Burning tokens is irreversible.';
    body.appendChild(warn);

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('BURN', executeBurn, comp.permissionNote));
  }

  function scheduleDiscovery() {
    state.liveChains = [];
    state.selectedChain = null;
    state.balance = null;
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
      loadBalance();
    });
  }

  function loadBalance() {
    // The REAL signer, not the View-as effective account — burnTokensOf burns from the connected wallet.
    var account = getAccount();
    if (!account || !state.selectedChain || !state.projectId) return;
    var tokensAddr = getAddress('JBTokens', state.selectedChain);
    if (!tokensAddr) return;

    executeRead({
      chainId: state.selectedChain,
      address: tokensAddr,
      abi: totalBalanceOfAbi,
      functionName: 'totalBalanceOf',
      args: [account, BigInt(state.projectId)],
    }).then(function(result) {
      state.balance = result;
      updateUI();
    }).catch(function() {});
  }

  function executeBurn() {
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
    if (state.balance !== null && tokenCount > state.balance) {
      state.error = 'That’s more than your balance of ' + formatAmount(state.balance, 18) + ' tokens.'; updateUI(); return;
    }

    var holder = getAccount();
    if (!holder) { state.error = 'Connect wallet first'; updateUI(); return; }

    var controllerAddr = getAddress('JBController', state.selectedChain);
    if (!controllerAddr) { state.error = 'No controller address for this chain'; updateUI(); return; }

    executeTransaction({
      ...buildBurnArgs({ chainId: state.selectedChain, controllerAddr: controllerAddr, holder: holder, projectId: state.projectId, tokenCount: tokenCount, memo: state.memo || '' }),
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; loadBalance(); updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
