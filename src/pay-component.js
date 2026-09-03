// src/pay-component.js
// Pay widget for the COMPONENTS tab
// Flow: project ID -> chain discovery -> token -> amount -> beneficiary -> memo -> preview -> pay

import {
  el, parseHashDefaults,
  discoverChains, createProjectAndChainInput, createComponentWrapper,
  executeTransaction, getBeneficiaryAddress, firstChainForNetwork,
  createPublicClientForChain, getChainTokens,
  parseAmount, renderError, getAddress,
  NATIVE_TOKEN, erc20DecimalsAbi, truncAddr,
} from './component-base.js';
import { computePayPreview, formatTokenCount, renderRoutingTag, renderAmmSub } from './pay-preview.js';
import { quotedOutputFloor } from './slippage.js';

export var payAbi = [{
  type: 'function', name: 'pay', stateMutability: 'payable',
  inputs: [
    { name: 'projectId', type: 'uint256' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
    { name: 'minReturnedTokens', type: 'uint256' },
    { name: 'memo', type: 'string' },
    { name: 'metadata', type: 'bytes' },
  ],
  outputs: [],
}];
var accountingContextsAbi = [{
  type: 'function', name: 'accountingContextsOf', stateMutability: 'view',
  inputs: [{ name: 'projectId', type: 'uint256' }],
  outputs: [{ name: 'contexts', type: 'tuple[]', components: [
    { name: 'token', type: 'address' }, { name: 'decimals', type: 'uint256' }, { name: 'currency', type: 'uint256' },
  ]}],
}];

// Pure builder for the JBMultiTerminal.pay transaction — returns the executeTransaction config (no callbacks).
// `o`: { chainId, projectId, token, amount (bigint), beneficiary, memo, route } where route carries the
// resolved terminal/router address and a `preview.received` (raw, BigInt-able) token estimate.
// minReturnedTokens is a 1% slippage floor off positive previewed output. A verified zero quote is valid for a
// zero-issuance project and deliberately encodes a zero floor; a missing/unavailable quote is still rejected.
export function buildPayArgs(o) {
  var isNative = sameAddress(String(o.token), NATIVE_TOKEN);
  var pv = o.route && o.route.preview;
  if (!pv || pv.unavailable || pv.received == null) throw new Error('A live pay preview is required.');
  var quoted = BigInt(pv.received);
  if (quoted < 0n) throw new Error('The pay preview returned an invalid project-token count.');
  var minReturned = quotedOutputFloor(quoted, 9900);
  return {
    chainId: o.chainId,
    address: o.route.address,
    contractName: o.route.contractName,
    abi: payAbi,
    functionName: 'pay',
    args: [BigInt(o.projectId), o.token, o.amount, o.beneficiary, minReturned, o.memo || '', '0x'],
    value: isNative ? o.amount : 0n,
    tokenAddr: isNative ? null : o.token,
    spenderAddr: isNative ? null : o.route.address,
    approvalAmount: isNative ? null : o.amount,
  };
}

function sameAddress(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function payPreviewScore(preview) {
  if (!preview || preview.unavailable || preview.received == null) return -1n;
  return BigInt(preview.received);
}

function payRouteIsBetter(candidate, current) {
  var candidateScore = payPreviewScore(candidate.preview);
  var currentScore = payPreviewScore(current && current.preview);
  if (candidateScore !== currentScore) return candidateScore > currentScore;

  var candidateTotal = candidate.preview && candidate.preview.reserved != null
    ? candidateScore + BigInt(candidate.preview.reserved) : candidateScore;
  var currentTotal = current && current.preview && current.preview.reserved != null
    ? currentScore + BigInt(current.preview.reserved) : currentScore;
  if (candidateTotal !== currentTotal) return candidateTotal > currentTotal;

  return !candidate.viaRouter && current && current.viaRouter;
}

function payRouteCandidates(chainId) {
  var routes = [];
  var router = getAddress('JBRouterTerminalRegistry', chainId);
  var direct = getAddress('JBMultiTerminal', chainId);
  if (router) routes.push({ address: router, contractName: 'JBRouterTerminalRegistry', viaRouter: true });
  if (direct && !sameAddress(direct, router)) {
    routes.push({ address: direct, contractName: 'JBMultiTerminal', viaRouter: false });
  }
  return routes;
}

// Exported for regression tests: this resolver is the fail-closed boundary
// between an RPC quote and the calldata's minReturnedTokens floor.
export function resolveBestPayRoute(opts) {
  var routes = payRouteCandidates(opts.chainId);
  if (!routes.length) return Promise.resolve(null);

  return Promise.all(routes.map(function (route) {
    return computePayPreview({
      chainId: opts.chainId,
      projectId: opts.projectId,
      token: opts.token,
      amount: opts.amount,
      beneficiary: opts.beneficiary,
      terminal: route.address,
    }).then(function (preview) {
      return Object.assign({}, route, { preview: preview });
    }).catch(function () {
      return Object.assign({}, route, { preview: { unavailable: true } });
    });
  })).then(function (resolved) {
    var best = null;
    for (var i = 0; i < resolved.length; i++) {
      if (!best || payRouteIsBetter(resolved[i], best)) best = resolved[i];
    }
    if (best && best.preview && !best.preview.unavailable && best.preview.received != null && BigInt(best.preview.received) >= 0n) return best;
    // Never turn an unavailable preview into a minReturnedTokens=0 payment. An exact, verified zero quote is a
    // legitimate zero-issuance payment; an RPC or terminal failure is not.
    return null;
  });
}

export function renderPayComponent() {
  var defaults = parseHashDefaults('pay');

  var state = {
    phase: 'idle',
    projectId: defaults.projectId || '',
    liveChains: [],
    selectedChain: defaults.chain ? Number(defaults.chain) : 1,
    tokens: getChainTokens(defaults.chain ? Number(defaults.chain) : 1),
    selectedToken: getChainTokens(defaults.chain ? Number(defaults.chain) : 1)[0] || null,
    amount: defaults.amount || '',
    decimals: defaults.decimals != null && defaults.decimals !== '' ? Number(defaults.decimals) : 18,
    beneficiary: defaults.beneficiary ? 'custom' : 'self',
    customBeneficiary: defaults.beneficiary || '',
    memo: defaults.memo || '',
    network: defaults.network || 'mainnet',
    _decimalsUnknown: false,
    preview: null,
    error: null,
    txStatus: null,
    _defaultToken: defaults.token || null,
    _defaultChain: defaults.chain ? Number(defaults.chain) : null,
  };

  var discoveryGeneration = 0;
  var tokenGeneration = 0;
  var previewGeneration = 0;
  var previewTimer = null;

  // Include the terminal's actual accounting contexts, not only the website's curated token catalog. This
  // keeps custom accepted tokens usable while retaining catalog tokens that may be routed into the project.
  function loadProjectTokens(chainId) {
    var term = getAddress('JBMultiTerminal', chainId);
    if (!term || !state.projectId) return;
    var gen = ++tokenGeneration;
    var client = createPublicClientForChain(chainId);
    client.readContract({ address: term, abi: accountingContextsAbi, functionName: 'accountingContextsOf', args: [BigInt(state.projectId)] }).then(function (contexts) {
      if (gen !== tokenGeneration || state.selectedChain !== chainId || !contexts || !contexts.length) return;
      var catalog = getChainTokens(chainId);
      var tokens = contexts.map(function (context) {
        var known = catalog.filter(function (token) { return sameAddress(token.address, context.token); })[0];
        return { address: context.token, decimals: Number(context.decimals), symbol: known ? known.symbol : truncAddr(context.token) };
      });
      catalog.forEach(function (token) {
        if (!tokens.some(function (candidate) { return sameAddress(candidate.address, token.address); })) tokens.push(token);
      });
      var wanted = state._defaultToken || (state.selectedToken && state.selectedToken.address);
      state.tokens = tokens;
      state.selectedToken = tokens.filter(function (token) { return sameAddress(token.address, wanted); })[0] || tokens[0] || null;
      state.decimals = state.selectedToken ? state.selectedToken.decimals : 18;
      state._defaultToken = null;
      state.preview = null;
      updateUI(); schedulePreview();
    }).catch(function () {});
  }

  var comp = createComponentWrapper('PAY', 'pay', state, function() {
    var params = {};
    if (state.projectId) params.projectId = state.projectId;
    if (state.selectedChain) params.chain = state.selectedChain;
    if (state.selectedToken) params.token = state.selectedToken.address;
    if (state.amount) params.amount = state.amount;
    if (state.decimals !== 18) params.decimals = state.decimals;
    if (state.beneficiary === 'custom' && state.customBeneficiary) params.beneficiary = state.customBeneficiary;
    if (state.memo) params.memo = state.memo;
    if (state.network === 'testnet') params.network = 'testnet';
    return params;
  }, { permissionNote: 'Permissionless. Anyone can pay a project unless payments are paused.' });

  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';

    // 0. Project ID + chain — always visible in component view, paired so the
    // chain choice sits in the same field as the project ID it modifies.
    body.appendChild(createProjectAndChainInput(state, scheduleDiscovery, function(cid) {
      if (cid === null) cid = firstChainForNetwork(state);
      if (cid) {
        state.selectedChain = cid;
        state.tokens = getChainTokens(cid);
        state.selectedToken = state.tokens[0] || null;
        state.decimals = state.selectedToken ? state.selectedToken.decimals : 18;
        loadProjectTokens(cid);
      }
      state.preview = null;
      state.txStatus = null;
      updateUI();
      schedulePreview();
    }));

    // 1. Amount row: [amount] [ETH/token] [Pay] — project-page style
    var amountRow = el('div', 'pay-amount-row');

    var amtInput = el('input', 'pay-amount-input');
    amtInput.type = 'number'; amtInput.step = 'any'; // decimals valid; default step (1) would mark fractional amounts invalid
    amtInput.placeholder = '0';
    amtInput.value = state.amount || '1';
    amtInput.addEventListener('input', function() {
      state.amount = amtInput.value.trim();
      state.preview = null;
      schedulePreview();
    });
    amountRow.appendChild(amtInput);

    if (state.tokens && state.tokens.length > 1) {
      var tokenSelect = el('select', 'pay-currency-btn');
      for (var t = 0; t < state.tokens.length; t++) {
        var opt = document.createElement('option');
        opt.value = state.tokens[t].address;
        opt.textContent = state.tokens[t].symbol;
        if (state.selectedToken && sameAddress(state.selectedToken.address, state.tokens[t].address)) {
          opt.selected = true;
        }
        tokenSelect.appendChild(opt);
      }
      // Auto-size the select to fit ONLY the currently selected option (not the
      // widest one, which is the browser default). Uses canvas text measurement
      // so the width can be applied synchronously — no flash of the widest
      // option between renders.
      function measureToken(text) {
        if (!measureToken.ctx) {
          var canvas = document.createElement('canvas');
          measureToken.ctx = canvas.getContext('2d');
        }
        measureToken.ctx.font = 'bold 12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        return measureToken.ctx.measureText(text).width;
      }
      function resizeTokenSelect() {
        var current = tokenSelect.options[tokenSelect.selectedIndex];
        if (!current) return;
        var textW = measureToken(current.textContent);
        // padding-left (14) + text + padding-right (26) + 4px buffer for sub-pixel rendering.
        tokenSelect.style.width = Math.ceil(textW + 14 + 26 + 4) + 'px';
      }
      resizeTokenSelect(); // synchronous — fires before the element appears
      tokenSelect.addEventListener('change', function() {
        resizeTokenSelect();
        var addr = tokenSelect.value;
        for (var ti = 0; ti < state.tokens.length; ti++) {
          if (state.tokens[ti].address === addr) {
            state.selectedToken = state.tokens[ti];
            state.decimals = state.tokens[ti].decimals;
            state._decimalsUnknown = false;
            state.preview = null;
            updateUI();
            schedulePreview();
            if (!state.tokens[ti].decimals && addr.toLowerCase() !== NATIVE_TOKEN.toLowerCase()) {
              lookupDecimals(addr);
            }
            break;
          }
        }
      });
      amountRow.appendChild(tokenSelect);
    } else {
      var currLabel = el('span', 'pay-currency-btn');
      currLabel.textContent = (state.selectedToken && state.selectedToken.symbol) || 'ETH';
      amountRow.appendChild(currLabel);
    }

    var payBtn = el('button', 'pay-btn');
    payBtn.textContent = 'PAY';
    payBtn.addEventListener('click', function() {
      if (state.phase === 'ready' || state.phase === 'idle') {
        executePay();
      } else {
        alert('This is a mock UI. Payments will work once contracts are deployed.');
      }
    });
    amountRow.appendChild(payBtn);
    body.appendChild(amountRow);

    // 2. "You get" preview — inline like project page
    var youGet = el('div', 'pay-you-get');
    var youLink = el('span', 'pay-you-link');
    youLink.textContent = (state.beneficiary === 'custom' && state.customBeneficiary)
      ? truncAddr(state.customBeneficiary)
      : 'You';
    youLink.title = 'Click to change beneficiary';
    var youGetText = el('span');

    if (state.preview && state.preview.beneficiaryTokens) {
      youGetText.textContent = ' get: ' + state.preview.beneficiaryTokens + ' tokens';
    } else if (state.phase === 'previewing') {
      youGetText.textContent = ' get: loading…';
    } else {
      youGetText.textContent = ' get: project tokens';
    }

    youGet.appendChild(youLink);
    youGet.appendChild(youGetText);
    // Routing tag (Issuance / AMM) when we have a preview.
    if (state.preview && state.preview.routing) {
      youGet.appendChild(renderRoutingTag(state.preview.routing));
    }
    body.appendChild(youGet);

    // AMM subtext (pool / quote) when the buyback route wins.
    if (state.preview && state.preview.routing === 'amm') {
      var ammSub = renderAmmSub(state.preview.amm);
      if (ammSub) body.appendChild(ammSub);
    }

    // "Splits get" line — the reserved portion.
    if (state.preview && state.preview.reservedTokens && state.preview.reservedTokens !== '0') {
      var splits = el('div', 'pay-splits-line');
      splits.textContent = 'Splits get ' + state.preview.reservedTokens + ' tokens';
      body.appendChild(splits);
    }

    // Beneficiary input (toggle via "You" click)
    var beneficiaryWrap = el('div', 'pay-beneficiary-wrap');
    beneficiaryWrap.style.display = (state._showBeneficiary) ? '' : 'none';
    var beneficiaryInput = el('input', 'pay-beneficiary-input');
    beneficiaryInput.type = 'text';
    beneficiaryInput.placeholder = '0x... beneficiary address';
    beneficiaryInput.value = state.customBeneficiary || '';
    beneficiaryInput.addEventListener('input', function() {
      state.customBeneficiary = beneficiaryInput.value.trim();
      state.beneficiary = state.customBeneficiary ? 'custom' : 'self';
      state.preview = null;
      updateUI();
      schedulePreview();
    });
    beneficiaryWrap.appendChild(beneficiaryInput);
    body.appendChild(beneficiaryWrap);

    youLink.addEventListener('click', function() {
      state._showBeneficiary = !state._showBeneficiary;
      beneficiaryWrap.style.display = state._showBeneficiary ? '' : 'none';
      if (state._showBeneficiary) beneficiaryInput.focus();
    });

    // 3. Memo
    var memo = el('input', 'pay-memo');
    memo.type = 'text';
    memo.placeholder = 'Add a memo (optional)';
    memo.value = state.memo || '';
    memo.addEventListener('input', function() {
      state.memo = memo.value;
    });
    body.appendChild(memo);

    // 4. Decimals helper — only shown when an unknown-decimals ERC-20 is
    // picked. Chain selection now lives inline with the project ID, so the
    // old "[+] details" toggle isn't needed anymore.
    if (state._decimalsUnknown) {
      var decHelper = el('div', 'decimal-helper');
      var decLbl = el('span', 'decimal-label');
      decLbl.textContent = 'decimals';
      decHelper.appendChild(decLbl);
      var decPills = el('div', 'decimal-pills');
      [6, 8, 18].forEach(function(d) {
        var dp = el('button', 'decimal-pill' + (state.decimals === d ? ' selected' : ''));
        dp.textContent = String(d);
        dp.addEventListener('click', function() {
          state.decimals = d;
          state._decimalsUnknown = false;
          state.preview = null;
          updateUI();
          schedulePreview();
        });
        decPills.appendChild(dp);
      });
      decHelper.appendChild(decPills);
      var decInput = el('input', 'field decimal-input');
      decInput.type = 'text';
      decInput.value = String(state.decimals);
      decInput.addEventListener('input', function() {
        var d = parseInt(decInput.value);
        if (!isNaN(d) && d >= 0 && d <= 77) {
          state.decimals = d;
          state.preview = null;
          var pills = decPills.querySelectorAll('.decimal-pill');
          for (var pi = 0; pi < pills.length; pi++) {
            pills[pi].className = 'decimal-pill' + (parseInt(pills[pi].textContent) === d ? ' selected' : '');
          }
          schedulePreview();
        }
      });
      decHelper.appendChild(decInput);
      body.appendChild(decHelper);
    }

    // 5. Error + status
    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }
  }

  function scheduleDiscovery() {
    state.liveChains = [];
    state.selectedChain = null;
    state.tokens = [];
    state.selectedToken = null;
    state.preview = null;
    state.error = null;
    state.txStatus = null;

    var pid = state.projectId;
    if (!pid || !/^\d+$/.test(pid) || pid === '0') {
      state.phase = 'idle';
      updateUI();
      return;
    }

    state.phase = 'discovering';
    updateUI();

    var gen = ++discoveryGeneration;
    discoverChains(pid, function(live) {
      if (gen !== discoveryGeneration) return;
      state.liveChains = live;
      if (!live.length) {
        state.selectedChain = null; state.tokens = []; state.selectedToken = null;
        state.phase = 'idle'; state.error = 'Project not found on a reachable supported chain.'; updateUI(); return;
      }

      var preferredChain = (state._defaultChain && live.indexOf(state._defaultChain) !== -1)
        ? state._defaultChain : firstChainForNetwork(state) || live[0];
      state.selectedChain = preferredChain;
      state.tokens = getChainTokens(preferredChain);

      var preferredToken = null;
      if (state._defaultToken) {
        for (var ti = 0; ti < state.tokens.length; ti++) {
          if (sameAddress(state.tokens[ti].address, state._defaultToken)) {
            preferredToken = state.tokens[ti];
            break;
          }
        }
      }
      state.selectedToken = preferredToken || state.tokens[0] || null;
      state.decimals = state.selectedToken ? state.selectedToken.decimals : 18;
      state._defaultChain = null;
      state.phase = 'ready';
      updateUI();
      loadProjectTokens(preferredChain);
    });
  }

  function schedulePreview() {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(loadPreview, 400);
  }

  function loadPreview() {
    if (!state.selectedChain || !state.selectedToken || !state.amount || !state.projectId) return;

    var amountParsed;
    try { amountParsed = parseAmount(state.amount, state.decimals); } catch (_) { return; }
    if (amountParsed === 0n) return;

    // Beneficiary doesn't affect the mint math; a placeholder lets the preview work pre-connect.
    var beneficiary = getBeneficiaryAddress(state) || undefined;

    state.phase = 'previewing';
    state.error = null;
    updateUI();

    var gen = ++previewGeneration;
    resolveBestPayRoute({
      chainId: state.selectedChain,
      projectId: state.projectId,
      token: state.selectedToken.address,
      amount: amountParsed,
      beneficiary: beneficiary,
    }).then(function (route) {
      if (gen !== previewGeneration) return;
      if (!route) {
        state.phase = 'ready';
        state.preview = null;
        state.error = 'No terminal address for this chain';
        updateUI();
        return;
      }
      var p = route.preview;
      state.phase = 'ready';
      state.preview = (!p || p.unavailable) ? null : {
        beneficiaryTokens: formatTokenCount(p.received),
        reservedTokens: formatTokenCount(p.reserved),
        routing: p.routing,
        amm: p.amm,
        route: {
          address: route.address,
          contractName: route.contractName,
          viaRouter: route.viaRouter,
        },
      };
      state.error = null;
      updateUI();
    }).catch(function () {
      if (gen !== previewGeneration) return;
      state.preview = null;
      state.phase = 'ready';
      updateUI();
    });
  }

  function executePay() {
    state.error = null;
    state.txStatus = null;

    if (!state.selectedChain || !state.selectedToken) {
      state.error = 'Select a project and chain'; updateUI(); return;
    }
    if (!state.amount) {
      state.error = 'Enter an amount'; updateUI(); return;
    }

    var amountParsed;
    try { amountParsed = parseAmount(state.amount, state.decimals); } catch (_) {
      state.error = 'Invalid amount'; updateUI(); return;
    }

    var beneficiary = getBeneficiaryAddress(state);
    if (!beneficiary) {
      state.error = state.beneficiary === 'custom' ? 'Enter a valid beneficiary address' : 'Connect wallet first';
      updateUI(); return;
    }

    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = null;
    previewGeneration++;

    state.phase = 'confirming';
    updateUI();

    resolveBestPayRoute({
      chainId: state.selectedChain,
      projectId: state.projectId,
      token: state.selectedToken.address,
      amount: amountParsed,
      beneficiary: beneficiary,
    }).then(function (route) {
      if (!route) {
        state.phase = 'ready';
        state.error = 'No terminal address for this chain';
        updateUI();
        return;
      }
      if (route.preview && !route.preview.unavailable) {
        state.preview = {
          beneficiaryTokens: formatTokenCount(route.preview.received),
          reservedTokens: formatTokenCount(route.preview.reserved),
          routing: route.preview.routing,
          amm: route.preview.amm,
          route: {
            address: route.address,
            contractName: route.contractName,
            viaRouter: route.viaRouter,
          },
        };
      }

      executeTransaction(Object.assign(buildPayArgs({
        chainId: state.selectedChain,
        projectId: state.projectId,
        token: state.selectedToken.address,
        amount: amountParsed,
        beneficiary: beneficiary,
        memo: state.memo || '',
        route: route,
      }), {
        confirmSummary: { action: 'Pay project #' + String(state.projectId), rows: [
          ['Paying', state.amount + ' ' + (state.selectedToken.symbol || '')],
          ['You get', formatTokenCount(route.preview.received) + ' tokens' + (route.preview.reserved ? ' (' + formatTokenCount(route.preview.reserved) + ' reserved for the project)' : '')],
          ['Minimum', formatTokenCount(quotedOutputFloor(BigInt(route.preview.received), 9900)) + ' tokens — reverts below this'],
          ['To', beneficiary],
          state.memo ? ['Memo', state.memo] : null,
        ].filter(Boolean) },
        onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
        onSuccess: function(msg) { state.phase = 'ready'; state.txStatus = { message: msg, success: true }; updateUI(); },
        onError: function(msg) { state.phase = 'ready'; state.error = msg; state.txStatus = null; updateUI(); },
      }));
    }).catch(function (err) {
      state.phase = 'ready';
      state.error = (err && (err.shortMessage || err.message)) || 'Could not resolve the pay route.';
      updateUI();
    });
  }

  function lookupDecimals(tokenAddr) {
    if (!state.selectedChain) return;
    var client = createPublicClientForChain(state.selectedChain);
    if (!client) { state._decimalsUnknown = true; updateUI(); return; }
    client.readContract({ address: tokenAddr, abi: erc20DecimalsAbi, functionName: 'decimals', args: [] })
      .then(function(result) {
        if (state.selectedToken && sameAddress(state.selectedToken.address, tokenAddr)) {
          state.decimals = Number(result);
          state.selectedToken.decimals = Number(result);
          state._decimalsUnknown = false;
          updateUI();
        }
      }).catch(function() { state._decimalsUnknown = true; updateUI(); });
  }

  updateUI();
  if (state.projectId) scheduleDiscovery();

  return wrapper;
}
