// src/cashout-component.js
// Cash Out component
// Flow: Project ID -> chain -> token to reclaim -> amount of project tokens -> beneficiary -> execute

import {
  el, createComponentWrapper, createProjectAndChainInput,
  createBeneficiaryInput, createWalletButton, discoverChains, selectChain,
  firstChainForNetwork, executeTransaction, executeRead, renderError, getAddress,
  getAccount, getEffectiveAccount, getChainTokens, parseAmount, formatAmount, parseHashDefaults,
  getBeneficiaryAddress, createPublicClientForChain, truncAddr, tokenByAddress,
} from './component-base.js';

export var cashOutAbi = [{
  type: 'function', name: 'cashOutTokensOf', stateMutability: 'nonpayable',
  inputs: [
    { name: 'holder', type: 'address' },
    { name: 'projectId', type: 'uint256' },
    { name: 'cashOutCount', type: 'uint256' },
    { name: 'tokenToReclaim', type: 'address' },
    { name: 'minTokensReclaimed', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [{ name: '', type: 'uint256' }],
}];

// 99% floor on the previewed reclaim (1% slippage, the cross-client default; the preview is pre-fee, so
// the floor is compared before the protocol fee applies) so a burn can't reclaim ~0 silently (surplus
// drained / MEV).
export function cashOutMinReclaimed(reclaimAmount) {
  try {
    var quoted = BigInt(reclaimAmount || 0);
    if (quoted <= 0n) return 0n;
    var floor = quoted * 99n / 100n;
    return floor > 0n ? floor : 1n;
  } catch (_) { return 0n; }
}
// Pure builder for JBMultiTerminal.cashOutTokensOf. `o`: { chainId, terminalAddr, holder, projectId,
// cashOutCount (bigint), tokenToReclaim, beneficiary, minReclaimed (bigint) }.
export function buildCashOutArgs(o) {
  if (o.minReclaimed == null || BigInt(o.minReclaimed) <= 0n) throw new Error('A non-zero cash out preview is required.');
  return {
    chainId: o.chainId,
    address: o.terminalAddr,
    abi: cashOutAbi,
    functionName: 'cashOutTokensOf',
    args: [o.holder, BigInt(o.projectId), o.cashOutCount, o.tokenToReclaim, BigInt(o.minReclaimed), o.beneficiary, '0x'],
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
var accountingContextsAbi = [{ type: 'function', name: 'accountingContextsOf', stateMutability: 'view', inputs: [{ name: 'projectId', type: 'uint256' }], outputs: [{ name: 'contexts', type: 'tuple[]', components: [{ name: 'token', type: 'address' }, { name: 'decimals', type: 'uint256' }, { name: 'currency', type: 'uint256' }] }] }];

export function renderCashOutComponent() {
  var defaults = parseHashDefaults('cashout');

  var initialChain = defaults.chain ? Number(defaults.chain) : 1; // default Ethereum mainnet
  var initialTokens = getChainTokens(initialChain);

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: initialChain,
    network: defaults.network || 'mainnet',
    tokens: initialTokens,
    selectedToken: initialTokens[0] || null,
    decimals: 18,
    amount: defaults.amount || '',
    beneficiary: defaults.beneficiary ? 'custom' : 'self',
    customBeneficiary: defaults.beneficiary || '',
    balance: null,
    error: null,
    txStatus: null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
    _defaultToken: defaults.token || null,
    contextsVerified: false,
    contextsLoading: false,
  };

  var discoveryGeneration = 0;
  var tokenGeneration = 0;

  var comp = createComponentWrapper('CASH OUT', 'cashout', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.selectedToken) params.token = state.selectedToken.address;
    if (state.amount) params.amount = state.amount;
    if (state.beneficiary === 'custom' && state.customBeneficiary) params.beneficiary = state.customBeneficiary;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Token holder burns their own tokens to reclaim a share of the project’s funds.' });
  var wrapper = comp.wrapper;
  var body = comp.body;

  function loadReclaimTokens(chainId) {
    var term = getAddress('JBMultiTerminal', chainId);
    var client = createPublicClientForChain(chainId);
    var wanted = state._defaultToken || (state.selectedToken && state.selectedToken.address);
    state.contextsVerified = false; state.contextsLoading = true;
    state.tokens = []; state.selectedToken = null;
    if (!term || !client || !state.projectId) {
      state.contextsLoading = false; state.error = 'Could not verify this project’s reclaim tokens.'; updateUI(); return;
    }
    var gen = ++tokenGeneration;
    updateUI();
    client.readContract({ address: term, abi: accountingContextsAbi, functionName: 'accountingContextsOf', args: [BigInt(state.projectId)] }).then(function (contexts) {
      if (gen !== tokenGeneration || state.selectedChain !== chainId) return;
      var catalog = getChainTokens(chainId);
      var tokens = (contexts || []).map(function (context) {
        var known = tokenByAddress(catalog, context.token);
        return { address: context.token, decimals: Number(context.decimals), currency: BigInt(context.currency), symbol: known ? known.symbol : truncAddr(context.token) };
      });
      if (!tokens.length) throw new Error('No accounting contexts');
      state.tokens = tokens; state.selectedToken = tokenByAddress(tokens, wanted) || tokens[0];
      state._defaultToken = null; state.contextsVerified = true; state.contextsLoading = false; state.error = null; updateUI();
    }).catch(function () {
      if (gen !== tokenGeneration || state.selectedChain !== chainId) return;
      state.tokens = []; state.selectedToken = null;
      state.contextsVerified = false; state.contextsLoading = false;
      state.error = 'Could not verify this project’s reclaim tokens.'; updateUI();
    });
  }

  function updateUI() {
    body.innerHTML = '';
    body.appendChild(createProjectAndChainInput(state, scheduleDiscovery, function(cid) {
      if (cid === null) cid = firstChainForNetwork(state);
      if (cid) { selectChain(state, cid); loadReclaimTokens(cid); }
      state.balance = null;
      state.txStatus = null;
      updateUI();
      loadBalance();
    }));


    // Balance display
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
      body.appendChild(balBox);
    }

    // Token to reclaim selector
    var tokenSection = el('div', 'component-section');
    var tokenLabel = el('label', 'input-label');
    tokenLabel.textContent = 'token to reclaim';
    tokenSection.appendChild(tokenLabel);
    if (state.tokens.length > 0) {
      var tokenSelect = el('select', 'field');
      tokenSelect.style.maxWidth = '320px';
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
            break;
          }
        }
      });
      tokenSection.appendChild(tokenSelect);
    } else if (state.contextsLoading) {
      var loadingTokens = el('div', 'type-hint'); loadingTokens.textContent = 'Loading verified accounting contexts…'; tokenSection.appendChild(loadingTokens);
    }
    body.appendChild(tokenSection);

    // Cash out count (project tokens to burn)
    var amtSection = el('div', 'component-section');
    var amtLabel = el('label', 'input-label');
    amtLabel.innerHTML = 'project tokens to cash out <span class="type-hint">18 decimals</span>';
    amtSection.appendChild(amtLabel);
    var amtInput = el('input', 'field numeric-field');
    amtInput.type = 'text';
    amtInput.placeholder = '100';
    amtInput.value = state.amount;
    amtInput.addEventListener('input', function() { state.amount = amtInput.value.trim(); });
    amtSection.appendChild(amtInput);
    body.appendChild(amtSection);

    // Beneficiary
    body.appendChild(createBeneficiaryInput(state, function() { updateUI(); }));

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('CASH OUT', executeCashOut, comp.permissionNote));
  }

  function scheduleDiscovery() {
    state.liveChains = [];
    state.selectedChain = null;
    state.balance = null;
    state.tokens = [];
    state.selectedToken = null;
    state.contextsVerified = false;
    state.contextsLoading = false;
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
      loadReclaimTokens(preferred);
    });
  }

  function loadBalance() {
    var account = getEffectiveAccount();
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

  // JBMultiTerminal.previewCashOutFrom — hook-aware reclaim (net of any data-hook fee, before the 2.5%
  // protocol fee). Used to set a slippage floor so a surplus drop / MEV can't turn a burn into ~0 reclaim.
  var previewCashOutAbi = [{
    type: 'function', name: 'previewCashOutFrom', stateMutability: 'view',
    inputs: [
      { name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' },
      { name: 'cashOutCount', type: 'uint256' }, { name: 'tokenToReclaim', type: 'address' },
      { name: 'beneficiary', type: 'address' }, { name: 'metadata', type: 'bytes' },
    ],
    outputs: [
      { name: 'ruleset', type: 'tuple', components: [
        { name: 'cycleNumber', type: 'uint256' }, { name: 'id', type: 'uint256' },
        { name: 'basedOnId', type: 'uint256' }, { name: 'start', type: 'uint256' },
        { name: 'duration', type: 'uint256' }, { name: 'weight', type: 'uint256' },
        { name: 'weightCutPercent', type: 'uint256' }, { name: 'approvalHook', type: 'address' },
        { name: 'metadata', type: 'uint256' },
      ]},
      { name: 'reclaimAmount', type: 'uint256' },
      { name: 'cashOutTaxRate', type: 'uint256' },
      { name: 'hookSpecifications', type: 'tuple[]', components: [
        { name: 'hook', type: 'address' }, { name: 'noop', type: 'bool' },
        { name: 'amount', type: 'uint256' }, { name: 'metadata', type: 'bytes' },
      ]},
    ],
  }];

  async function executeCashOut() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.projectId) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }
    if (!state.contextsVerified) { state.error = state.contextsLoading ? 'Reclaim tokens are still loading.' : 'Could not verify this project’s reclaim tokens.'; updateUI(); return; }
    if (!state.amount) { state.error = 'Enter a token count'; updateUI(); return; }
    if (!state.selectedToken) { state.error = 'Select a token to reclaim'; updateUI(); return; }

    var cashOutCount;
    try { cashOutCount = parseAmount(state.amount, 18); } catch (_) {
      state.error = 'Invalid token count'; updateUI(); return;
    }
    if (cashOutCount <= 0n) { state.error = 'Enter a token count'; updateUI(); return; }
    if (state.balance != null && cashOutCount > BigInt(state.balance)) { state.error = 'Amount exceeds your project token balance'; updateUI(); return; }

    var holder = getAccount();
    if (!holder) { state.error = 'Connect wallet first'; updateUI(); return; }

    var beneficiary = getBeneficiaryAddress(state);
    if (!beneficiary) {
      state.error = state.beneficiary === 'custom' ? 'Enter a valid beneficiary address' : 'Connect wallet first';
      updateUI(); return;
    }

    var terminalAddr = getAddress('JBMultiTerminal', state.selectedChain);
    if (!terminalAddr) { state.error = 'No terminal address for this chain'; updateUI(); return; }
    var chainId = state.selectedChain;
    var reclaimToken = state.selectedToken.address;
    var amountText = state.amount;

    // Slippage floor: 99% of the previewed reclaim (1% tolerance, the cross-client default). A nonzero
    // terminal minimum forces the direct treasury route, so this floor also keeps a buyback data hook from
    // AMM-routing the cash out. Reverts a burn that would reclaim near-zero (surplus drained / MEV)
    // instead of letting it silently succeed.
    var minReclaimed = 0n;
    try {
      var preview = await executeRead({
        chainId: chainId, address: terminalAddr, abi: previewCashOutAbi, functionName: 'previewCashOutFrom',
        args: [holder, BigInt(state.projectId), cashOutCount, reclaimToken, beneficiary, '0x'],
      });
      var reclaim = preview && (preview.reclaimAmount != null ? preview.reclaimAmount : preview[1]);
      minReclaimed = cashOutMinReclaimed(reclaim);
    } catch (error) {
      state.error = (error && (error.shortMessage || error.message)) || 'Could not preview this cash out.';
      updateUI(); return;
    }
    if (minReclaimed === 0n) {
      state.error = 'This cash out currently returns 0 tokens. Nothing was sent.';
      updateUI(); return;
    }
    if (state.selectedChain !== chainId || state.amount !== amountText || !state.selectedToken
      || state.selectedToken.address.toLowerCase() !== reclaimToken.toLowerCase()
      || String(getBeneficiaryAddress(state) || '').toLowerCase() !== beneficiary.toLowerCase()) {
      state.error = 'Cash out inputs changed while the preview was loading. Review the refreshed form and try again.';
      updateUI(); return;
    }

    executeTransaction(Object.assign(buildCashOutArgs({
      chainId: chainId, terminalAddr: terminalAddr, holder: holder, projectId: state.projectId,
      cashOutCount: cashOutCount, tokenToReclaim: reclaimToken, beneficiary: beneficiary, minReclaimed: minReclaimed,
    }), {
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; loadBalance(); updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    }));
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();
  return wrapper;
}
