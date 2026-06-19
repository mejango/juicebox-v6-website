// src/form.js
// Renders an ABI function definition into an interactive DOM form
// Each form has its own chain selector. Chain selection is remembered globally.

import { renderInput } from './inputs.js';
import { getAccount, getWalletClient, createPublicClientForChain, connect, onWalletChange } from './wallet.js';
import { confirmTransactionModal } from './component-base.js';
import { getCurrentChainId, setCurrentChainId, getManifestChains, getCustomRpc, setCustomRpc, CHAINS } from './chain.js';
import { parseAmount, decodeError } from './encoding.js';
import { renderResult } from './results.js';
import { renderError } from './errors.js';

export function renderFunctionForm(fn, contractName, getContractAddr, abi, fnNatspec) {
  var container = document.createElement('div');
  container.className = 'function-form';

  var isRead = fn.stateMutability === 'view' || fn.stateMutability === 'pure';
  var isPayable = fn.stateMutability === 'payable';

  // Per-form chain state (defaults to global remembered chain)
  var formChainId = getCurrentChainId();

  // NatSpec documentation block
  if (fnNatspec) {
    var docsBlock = document.createElement('div');
    docsBlock.className = 'fn-natspec';
    if (fnNatspec.notice) {
      var noticeEl = document.createElement('div');
      noticeEl.className = 'natspec-notice';
      noticeEl.textContent = fnNatspec.notice;
      docsBlock.appendChild(noticeEl);
    }
    if (fnNatspec.details) {
      var detailsEl = document.createElement('div');
      detailsEl.className = 'natspec-details';
      detailsEl.textContent = fnNatspec.details;
      docsBlock.appendChild(detailsEl);
    }
    container.appendChild(docsBlock);
  }

  // Input fields
  var inputs = [];
  var inputContainer = document.createElement('div');
  inputContainer.className = 'fn-inputs';

  // Build context for smart behaviors
  var paramDescriptions = (fnNatspec && fnNatspec.params) ? fnNatspec.params : {};
  var context = {
    hasTokenParam: fn.inputs.some(function(p) { return /^_?token$/i.test(p.name); }),
    isPayable: isPayable,
  };

  for (var i = 0; i < fn.inputs.length; i++) {
    var param = fn.inputs[i];
    var paramWithDesc = param;
    // Attach NatSpec param description if available
    var descKey = param.name;
    if (!paramDescriptions[descKey] && descKey.charAt(0) === '_') {
      descKey = descKey.slice(1);
    }
    if (paramDescriptions[descKey] || paramDescriptions[param.name]) {
      paramWithDesc = Object.assign({}, param, {
        description: paramDescriptions[param.name] || paramDescriptions[descKey]
      });
    }
    var input = renderInput(paramWithDesc, context, 0);
    inputs.push(input);
    inputContainer.appendChild(input);
  }

  // msg.value field for payable functions
  var valueInput = null;
  if (isPayable) {
    var valueSep = document.createElement('div');
    valueSep.className = 'value-separator';
    inputContainer.appendChild(valueSep);

    valueInput = document.createElement('div');
    valueInput.className = 'input-group payable-value';
    var valLabel = document.createElement('label');
    valLabel.className = 'input-label payable-label';
    valLabel.innerHTML = 'msg.value <span class="type-hint">ETH</span>';
    valueInput.appendChild(valLabel);
    var valField = document.createElement('input');
    valField.type = 'text';
    valField.className = 'field numeric-field payable-field';
    valField.placeholder = '0';
    valueInput.appendChild(valField);
    valueInput.getValue = function() { return valField.value; };
    inputContainer.appendChild(valueInput);
  }

  container.appendChild(inputContainer);

  // Chain selector (between inputs and buttons)
  var chainSelector = renderFormChainSelector(formChainId, function(newChainId) {
    formChainId = newChainId;
    setCurrentChainId(newChainId);
  });
  container.appendChild(chainSelector);

  // Action buttons
  var actions = document.createElement('div');
  actions.className = 'fn-actions';

  if (isRead) {
    var queryBtn = document.createElement('button');
    queryBtn.className = 'btn btn-query';
    queryBtn.textContent = 'QUERY';
    queryBtn.addEventListener('click', function() {
      var addr = getContractAddr(formChainId);
      executeRead(fn, inputs, addr, abi, outputArea, formChainId);
    });
    actions.appendChild(queryBtn);
  } else {
    var txBtn = document.createElement('button');

    function updateTxBtn() {
      if (getAccount()) {
        txBtn.className = 'btn btn-transact';
        txBtn.textContent = 'TRANSACT';
      } else {
        txBtn.className = 'btn btn-connect';
        txBtn.textContent = 'CONNECT WALLET';
      }
    }
    updateTxBtn();
    onWalletChange(updateTxBtn);

    txBtn.addEventListener('click', function() {
      if (!getAccount()) {
        connect().catch(function(e) { outputArea.innerHTML = ''; outputArea.appendChild(renderError(e.message)); });
        return;
      }
      var addr = getContractAddr(formChainId);
      executeWrite(fn, inputs, valueInput, addr, abi, outputArea, formChainId);
    });
    actions.appendChild(txBtn);

    var simBtn = document.createElement('button');
    simBtn.className = 'btn btn-simulate';
    simBtn.textContent = 'SIMULATE';
    simBtn.addEventListener('click', function() {
      var addr = getContractAddr(formChainId);
      executeSimulate(fn, inputs, valueInput, addr, abi, outputArea, formChainId);
    });
    actions.appendChild(simBtn);
  }

  container.appendChild(actions);

  // Result/error area (after buttons)
  var outputArea = document.createElement('div');
  outputArea.className = 'fn-output';
  container.appendChild(outputArea);

  return container;
}

// --- Per-form chain selector ---

function renderFormChainSelector(initialChainId, onChange) {
  var wrapper = document.createElement('div');
  wrapper.className = 'fn-chain-selector';

  var chains = getManifestChains();
  var selectedChain = initialChainId;
  var rpcExpanded = false;

  // Determine initial network from selected chain
  var selectedNetwork = (chains[String(selectedChain)] && chains[String(selectedChain)].testnet) ? 'testnet' : 'mainnet';

  function render() {
    wrapper.innerHTML = '';

    var chainIds = Object.keys(chains);
    var isTestnet = selectedNetwork === 'testnet';

    // Network dropdown
    var netSelect = document.createElement('select');
    netSelect.className = 'network-dropdown';
    var mainOpt = document.createElement('option');
    mainOpt.value = 'mainnet';
    mainOpt.textContent = 'mainnet';
    if (selectedNetwork === 'mainnet') mainOpt.selected = true;
    netSelect.appendChild(mainOpt);
    var testOpt = document.createElement('option');
    testOpt.value = 'testnet';
    testOpt.textContent = 'testnet';
    if (selectedNetwork === 'testnet') testOpt.selected = true;
    netSelect.appendChild(testOpt);
    netSelect.addEventListener('change', function() {
      selectedNetwork = netSelect.value;
      // Auto-select first chain in new network
      var wantTestnet = selectedNetwork === 'testnet';
      for (var ci = 0; ci < chainIds.length; ci++) {
        var ch = chains[chainIds[ci]];
        if (!!ch.testnet === wantTestnet) {
          selectedChain = parseInt(chainIds[ci]);
          break;
        }
      }
      render();
      onChange(selectedChain);
    });
    wrapper.appendChild(netSelect);

    // Chain pills filtered by network
    var pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';

    for (var i = 0; i < chainIds.length; i++) {
      var cid = chainIds[i];
      var ch = chains[cid];
      if (!!ch.testnet !== isTestnet) continue;
      var pill = document.createElement('button');
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (parseInt(cid) === selectedChain ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.addEventListener('click', function(e) {
        selectedChain = parseInt(e.currentTarget.dataset.chainId);
        render();
        onChange(selectedChain);
      });
      pillsRow.appendChild(pill);
    }

    wrapper.appendChild(pillsRow);

    // Custom RPC toggle + input
    var rpcToggle = document.createElement('button');
    rpcToggle.className = 'custom-rpc-toggle';
    rpcToggle.textContent = 'custom rpc';
    rpcToggle.addEventListener('click', function() {
      rpcExpanded = !rpcExpanded;
      render();
    });
    wrapper.appendChild(rpcToggle);

    if (rpcExpanded) {
      var rpcRow = document.createElement('div');
      rpcRow.className = 'custom-rpc-row';

      var rpcInput = document.createElement('input');
      rpcInput.type = 'text';
      rpcInput.className = 'field custom-rpc-input';

      // Show saved custom RPC or the chain's default URL as placeholder
      var saved = getCustomRpc(selectedChain);
      var chain = CHAINS[selectedChain];
      var defaultUrl = '';
      if (chain && chain.rpcUrls && chain.rpcUrls.default && chain.rpcUrls.default.http) {
        defaultUrl = chain.rpcUrls.default.http[0] || '';
      }
      rpcInput.value = saved;
      rpcInput.placeholder = defaultUrl || 'https://...';

      rpcInput.addEventListener('change', function() {
        var val = rpcInput.value.trim();
        setCustomRpc(selectedChain, val);
      });

      rpcRow.appendChild(rpcInput);
      wrapper.appendChild(rpcRow);
    }
  }

  render();
  return wrapper;
}

// --- Execution helpers ---

function validateInputs(inputs) {
  for (var i = 0; i < inputs.length; i++) {
    var err = inputs[i].validate();
    if (err) return err;
  }
  return null;
}

function executeRead(fn, inputs, contractAddress, abi, outputArea, chainId) {
  outputArea.innerHTML = '';
  var client = createPublicClientForChain(chainId);
  if (!client) { outputArea.appendChild(renderError('No RPC available for this chain')); return; }
  if (!contractAddress) { outputArea.appendChild(renderError('No contract address for this chain')); return; }

  var validationErr = validateInputs(inputs);
  if (validationErr) { outputArea.appendChild(renderError(validationErr)); return; }

  var args = inputs.map(function(inp) { return inp.getValue(); });

  client.readContract({
    address: contractAddress,
    abi: [fn],
    functionName: fn.name,
    args: args,
  }).then(function(result) {
    outputArea.innerHTML = '';
    outputArea.appendChild(renderResult(fn.outputs, result));
  }).catch(function(err) {
    outputArea.innerHTML = '';
    outputArea.appendChild(renderError(formatError(err, abi)));
  });
}

function executeWrite(fn, inputs, valueInput, contractAddress, abi, outputArea, chainId) {
  outputArea.innerHTML = '';
  var wallet = getWalletClient();
  var pub = createPublicClientForChain(chainId);
  if (!wallet) { outputArea.appendChild(renderError('Connect wallet to transact')); return; }
  if (!contractAddress) { outputArea.appendChild(renderError('No contract address for this chain')); return; }

  var validationErr = validateInputs(inputs);
  if (validationErr) { outputArea.appendChild(renderError(validationErr)); return; }

  // Network mismatch check
  wallet.getChainId().then(function(walletChainId) {
    if (walletChainId !== chainId) {
      outputArea.appendChild(renderError('Wallet is on chain ' + walletChainId + ', but you selected chain ' + chainId + '. Switch your wallet network.'));
      return;
    }

    var args = inputs.map(function(inp) { return inp.getValue(); });
    var value = valueInput ? parseEtherSafe(valueInput.getValue()) : undefined;

    // Review the exact call before sending.
    confirmTransactionModal({
      action: fn.name,
      chain: (CHAINS[chainId] && CHAINS[chainId].name) || ('chain ' + chainId),
      contract: contractAddress,
      function: fn.name,
      args: args,
      value: value || 0n,
    }, { title: 'Confirm transaction' }).then(function(ok) {
      if (!ok) { outputArea.innerHTML = ''; outputArea.appendChild(renderError('Transaction cancelled')); return; }
      outputArea.innerHTML = '<div class="tx-pending">Awaiting wallet confirmation...</div>';
      wallet.writeContract({
        address: contractAddress,
        abi: [fn],
        functionName: fn.name,
        args: args,
        value: value,
      }).then(function(hash) {
        outputArea.innerHTML = '<div class="tx-success">TX submitted: ' + hash + '</div>';
        return pub.waitForTransactionReceipt({ hash: hash });
      }).then(function(receipt) {
        outputArea.innerHTML = '<div class="tx-success">Confirmed in block ' + receipt.blockNumber + ' | TX: ' + truncateAddress(receipt.transactionHash) + '</div>';
      }).catch(function(err) {
        outputArea.innerHTML = '';
        outputArea.appendChild(renderError(formatError(err, abi)));
      });
    });
  });
}

function executeSimulate(fn, inputs, valueInput, contractAddress, abi, outputArea, chainId) {
  outputArea.innerHTML = '';
  var pub = createPublicClientForChain(chainId);
  if (!pub) { outputArea.appendChild(renderError('No RPC available for this chain')); return; }
  if (!contractAddress) { outputArea.appendChild(renderError('No contract address for this chain')); return; }

  var validationErr = validateInputs(inputs);
  if (validationErr) { outputArea.appendChild(renderError(validationErr)); return; }

  var args = inputs.map(function(inp) { return inp.getValue(); });
  var value = valueInput ? parseEtherSafe(valueInput.getValue()) : undefined;

  outputArea.innerHTML = '<div class="tx-pending">Simulating...</div>';

  pub.simulateContract({
    address: contractAddress,
    abi: [fn],
    functionName: fn.name,
    args: args,
    value: value,
    account: getAccount(),
  }).then(function(sim) {
    outputArea.innerHTML = '';
    var successDiv = document.createElement('div');
    successDiv.className = 'sim-success';
    successDiv.textContent = 'Simulation OK';
    outputArea.appendChild(successDiv);
    if (fn.outputs && fn.outputs.length > 0) {
      outputArea.appendChild(renderResult(fn.outputs, sim.result));
    }
  }).catch(function(err) {
    outputArea.innerHTML = '';
    outputArea.appendChild(renderError(formatError(err, abi)));
  });
}

function parseEtherSafe(val) {
  if (!val || val === '0' || val.trim() === '') return 0n;
  return parseAmount(val, 18);
}

function formatError(err, abi) {
  if (err.message && err.message.includes('User rejected')) return 'Transaction rejected by wallet';
  if (err.data && abi) {
    var decoded = decodeError(abi, err.data);
    if (decoded) return 'Reverted: ' + decoded.errorName + '(' + decoded.args.join(', ') + ')';
    return 'Reverted: ' + err.data;
  }
  return err.shortMessage || err.message || 'Unknown error';
}

function truncateAddress(addr) {
  if (!addr || addr.length < 10) return addr;
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}
