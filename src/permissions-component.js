// src/permissions-component.js
// Set Permissions component
// Flow: account -> operator -> project ID -> select permissions -> execute

import {
  el, createComponentWrapper, createWalletButton, executeTransaction,
  renderError, getAddress, getAccount, parseHashDefaults, isAddr, truncAddr,
} from './component-base.js';

export var setPermissionsAbi = [{
  type: 'function', name: 'setPermissionsFor', stateMutability: 'nonpayable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'permissionsData', type: 'tuple', components: [
      { name: 'operator', type: 'address' },
      { name: 'projectId', type: 'uint64' },
      { name: 'permissionIds', type: 'uint8[]' },
    ]},
  ],
  outputs: [],
}];

// Pure builder for JBPermissions.setPermissionsFor. `o`: { chainId, permissionsAddr, account, operator,
// projectId, permissionIds (uint8[]) }. The permissionIds map to nana-permission-ids-v6 (see PERMISSIONS).
export function buildSetPermissionsArgs(o) {
  return {
    chainId: o.chainId, address: o.permissionsAddr, abi: setPermissionsAbi, functionName: 'setPermissionsFor',
    args: [o.account, { operator: o.operator, projectId: Number(o.projectId) || 0, permissionIds: o.permissionIds }],
  };
}

// Complete permission IDs from nana-permission-ids-v6
var PERMISSION_IDS = [
  { id: 1, name: 'ROOT', desc: 'Grants all permissions' },
  { id: 2, name: 'QUEUE_RULESETS', desc: 'Queue new rulesets' },
  { id: 3, name: 'LAUNCH_RULESETS', desc: 'Launch first rulesets' },
  { id: 4, name: 'CASH_OUT_TOKENS', desc: 'Cash out tokens' },
  { id: 5, name: 'SEND_PAYOUTS', desc: 'Send payouts' },
  { id: 6, name: 'MIGRATE_TERMINAL', desc: 'Migrate terminal balance' },
  { id: 7, name: 'SET_PROJECT_URI', desc: 'Set project metadata URI' },
  { id: 8, name: 'DEPLOY_ERC20', desc: 'Deploy ERC-20 token' },
  { id: 9, name: 'SET_TOKEN', desc: 'Set existing ERC-20' },
  { id: 10, name: 'MINT_TOKENS', desc: 'Mint project tokens' },
  { id: 11, name: 'BURN_TOKENS', desc: 'Burn project tokens' },
  { id: 12, name: 'CLAIM_TOKENS', desc: 'Claim credits as ERC-20' },
  { id: 13, name: 'TRANSFER_CREDITS', desc: 'Transfer token credits' },
  { id: 14, name: 'SET_CONTROLLER', desc: 'Set project controller' },
  { id: 15, name: 'SET_TERMINALS', desc: 'Set terminal list' },
  { id: 16, name: 'ADD_TERMINALS', desc: 'Add new terminal' },
  { id: 17, name: 'SET_PRIMARY_TERMINAL', desc: 'Set primary terminal' },
  { id: 18, name: 'USE_ALLOWANCE', desc: 'Spend surplus allowance' },
  { id: 19, name: 'SET_SPLIT_GROUPS', desc: 'Configure splits' },
  { id: 20, name: 'ADD_PRICE_FEED', desc: 'Add price feed' },
  { id: 21, name: 'ADD_ACCOUNTING_CONTEXTS', desc: 'Register token types' },
  { id: 22, name: 'SET_TOKEN_METADATA', desc: 'Update ERC-20 metadata' },
  { id: 23, name: 'SIGN_FOR_ERC20', desc: 'Sign via ERC-1271' },
  { id: 24, name: 'ADJUST_721_TIERS', desc: 'Modify NFT tiers' },
  { id: 25, name: 'SET_721_METADATA', desc: 'Update NFT metadata' },
  { id: 26, name: 'MINT_721', desc: 'Mint NFTs directly' },
  { id: 27, name: 'SET_721_DISCOUNT_PERCENT', desc: 'Set tier discount' },
  { id: 28, name: 'SET_BUYBACK_TWAP', desc: 'Set TWAP window' },
  { id: 29, name: 'SET_BUYBACK_POOL', desc: 'Set buyback pool' },
  { id: 30, name: 'SET_BUYBACK_HOOK', desc: 'Configure buyback hook' },
  { id: 31, name: 'SET_ROUTER_TERMINAL', desc: 'Configure router terminal' },
  { id: 32, name: 'MAP_SUCKER_TOKEN', desc: 'Map cross-chain token' },
  { id: 33, name: 'DEPLOY_SUCKERS', desc: 'Deploy cross-chain bridges' },
  // Canonical JBPermissionIds.sol: 34=SET_SUCKER_PEER, 35=SUCKER_SAFETY, 36=SET_SUCKER_DEPRECATION.
  // (Previously shifted — checking "SUCKER_SAFETY" granted SET_SUCKER_PEER, a materially more dangerous role.)
  { id: 34, name: 'SET_SUCKER_PEER', desc: 'Set a sucker’s cross-chain peer' },
  { id: 35, name: 'SUCKER_SAFETY', desc: 'Emergency token recovery' },
  { id: 36, name: 'SET_SUCKER_DEPRECATION', desc: 'Deprecate sucker' },
  { id: 37, name: 'OPEN_LOAN', desc: 'Open loan against tokens' },
  { id: 38, name: 'REALLOCATE_LOAN', desc: 'Move loan collateral' },
  { id: 39, name: 'REPAY_LOAN', desc: 'Repay loan' },
];

var PERMISSION_GROUPS = [
  { label: 'Core', ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
  { label: 'NFT', ids: [24, 25, 26, 27] },
  { label: 'Buyback', ids: [28, 29, 30] },
  { label: 'Router', ids: [31] }, // SET_ROUTER_TERMINAL — its own concern, not buyback
  { label: 'Omnichain', ids: [32, 33, 34, 35, 36] }, // 36 = SET_SUCKER_DEPRECATION (a sucker permission)
  { label: 'RevNet', ids: [37, 38, 39] },
];

export function renderPermissionsComponent() {
  var defaults = parseHashDefaults('permissions');

  var state = {
    operator: defaults.operator || '',
    projectId: defaults.projectId || '',
    selectedIds: {},
    chainId: 1,
    error: null,
    txStatus: null,
  };

  var comp = createComponentWrapper('SET PERMISSIONS', 'permissions', state, function() {
    var params = {};
    if (state.operator) params.operator = state.operator;
    if (state.projectId) params.projectId = state.projectId;
    var sel = Object.keys(state.selectedIds).filter(function(k) { return state.selectedIds[k]; });
    if (sel.length) params.ids = sel.join(',');
    return params;
  }, { permissionNote: 'Only the account itself (or a ROOT operator for that project) can set permissions.' });

  var wrapper = comp.wrapper;
  var body = comp.body;

  function updateUI() {
    body.innerHTML = '';

    // Project ID + chain — paired as a single field since a project ID only
    // refers to a specific project on a specific chain. Chain summary sits
    // above the project ID input; click "on <chain>" to reveal the picker.
    var chainOptions = [
      { id: 1, name: 'Ethereum' }, { id: 10, name: 'Optimism' },
      { id: 42161, name: 'Arbitrum' }, { id: 8453, name: 'Base' },
      { id: 11155111, name: 'Sepolia' }, { id: 11155420, name: 'OP Sepolia' },
      { id: 84532, name: 'Base Sepolia' }, { id: 421614, name: 'Arb Sepolia' },
    ];
    var currentChainName = (chainOptions.find(function(c) { return c.id === state.chainId; }) || {}).name || 'Ethereum';

    var pidSection = el('div', 'component-section project-chain-section');
    var pidLabel = el('label', 'input-label');
    pidLabel.innerHTML = 'project ID <span class="type-hint">0 = all projects on the chosen chain</span>';
    pidSection.appendChild(pidLabel);

    var chainWrap = el('div', 'project-chain-wrap');
    var summary = document.createElement('a');
    summary.className = 'project-chain-summary';
    summary.href = '#';
    summary.textContent = (state._showChainPicker ? '▾' : '▸') + ' on ' + currentChainName;
    chainWrap.appendChild(summary);

    var picker = el('div', 'project-chain-picker');
    picker.style.display = state._showChainPicker ? '' : 'none';
    var chainSelect = el('select', 'field project-chain-select');
    chainSelect.style.maxWidth = '200px';
    for (var ci = 0; ci < chainOptions.length; ci++) {
      var copt = document.createElement('option');
      copt.value = chainOptions[ci].id;
      copt.textContent = chainOptions[ci].name;
      if (state.chainId === chainOptions[ci].id) copt.selected = true;
      chainSelect.appendChild(copt);
    }
    chainSelect.addEventListener('change', function() {
      state.chainId = Number(chainSelect.value);
      var newName = (chainOptions.find(function(c) { return c.id === state.chainId; }) || {}).name || 'Ethereum';
      summary.textContent = (state._showChainPicker ? '▾' : '▸') + ' on ' + newName;
    });
    picker.appendChild(chainSelect);
    chainWrap.appendChild(picker);

    summary.addEventListener('click', function(e) {
      e.preventDefault();
      state._showChainPicker = !state._showChainPicker;
      picker.style.display = state._showChainPicker ? '' : 'none';
      var name = (chainOptions.find(function(c) { return c.id === state.chainId; }) || {}).name || 'Ethereum';
      summary.textContent = (state._showChainPicker ? '▾' : '▸') + ' on ' + name;
    });

    pidSection.appendChild(chainWrap);

    var pidInput = el('input', 'field numeric-field');
    pidInput.type = 'text';
    pidInput.placeholder = '0';
    pidInput.value = state.projectId;
    pidInput.addEventListener('input', function() { state.projectId = pidInput.value.trim(); });
    pidSection.appendChild(pidInput);
    body.appendChild(pidSection);

    // Operator address
    var opSection = el('div', 'component-section');
    var opLabel = el('label', 'input-label');
    opLabel.textContent = 'operator address';
    opSection.appendChild(opLabel);
    var opInput = el('input', 'field address-field');
    opInput.type = 'text';
    opInput.placeholder = '0x...';
    opInput.value = state.operator;
    opInput.addEventListener('input', function() { state.operator = opInput.value.trim(); });
    opSection.appendChild(opInput);
    body.appendChild(opSection);

    // Permission checkboxes grouped
    var permsSection = el('div', 'component-section');
    var permsLabel = el('label', 'input-label');
    permsLabel.textContent = 'permissions';
    permsSection.appendChild(permsLabel);

    for (var g = 0; g < PERMISSION_GROUPS.length; g++) {
      var group = PERMISSION_GROUPS[g];
      var groupEl = el('div', 'permission-group');

      var groupHeader = el('div', 'permission-group-header');
      groupHeader.textContent = group.label;
      groupEl.appendChild(groupHeader);

      for (var p = 0; p < group.ids.length; p++) {
        (function(pid) {
          var perm = PERMISSION_IDS.find(function(x) { return x.id === pid; });
          if (!perm) return;

          var row = el('label', 'permission-row');
          var cb = el('input', '');
          cb.type = 'checkbox';
          cb.checked = !!state.selectedIds[pid];
          cb.addEventListener('change', function() {
            if (cb.checked) {
              state.selectedIds[pid] = true;
            } else {
              delete state.selectedIds[pid];
            }
          });
          row.appendChild(cb);

          var idSpan = el('span', 'permission-id');
          idSpan.textContent = pid;
          row.appendChild(idSpan);

          var nameSpan = el('span', 'permission-name');
          nameSpan.textContent = perm.name;
          row.appendChild(nameSpan);

          var descSpan = el('span', 'permission-desc');
          descSpan.textContent = perm.desc;
          row.appendChild(descSpan);

          groupEl.appendChild(row);
        })(group.ids[p]);
      }

      permsSection.appendChild(groupEl);
    }
    body.appendChild(permsSection);

    if (state.error) body.appendChild(renderError(state.error));
    if (state.txStatus) {
      var txDiv = el('div', state.txStatus.success ? 'tx-success' : 'component-status');
      txDiv.textContent = state.txStatus.message;
      body.appendChild(txDiv);
    }

    body.appendChild(createWalletButton('SET PERMISSIONS', executeSetPermissions, comp.permissionNote));
  }

  function executeSetPermissions() {
    state.error = null;
    state.txStatus = null;

    if (!state.operator || !isAddr(state.operator)) {
      state.error = 'Enter a valid operator address'; updateUI(); return;
    }

    var account = getAccount();
    if (!account) { state.error = 'Connect wallet first'; updateUI(); return; }

    var selectedArr = Object.keys(state.selectedIds)
      .filter(function(k) { return state.selectedIds[k]; })
      .map(Number)
      .sort(function(a, b) { return a - b; });

    if (selectedArr.length === 0) {
      state.error = 'Select at least one permission'; updateUI(); return;
    }

    var permissionsAddr = getAddress('JBPermissions', state.chainId);
    if (!permissionsAddr) { state.error = 'No JBPermissions address for this chain'; updateUI(); return; }

    var projectId = state.projectId ? Number(state.projectId) : 0;

    // Flag the two highest-stakes grants explicitly in the confirm (the decoded `permissionIds: [1]` alone
    // doesn't convey "full control"): ROOT (id 1) = every permission; projectId 0 = ALL of your projects.
    var danger = [];
    if (selectedArr.indexOf(1) !== -1) danger.push('⚠ ROOT grants ' + truncAddr(state.operator) + ' EVERY permission — full operator control of your project(s).');
    if (projectId === 0) danger.push('⚠ Project ID 0 applies these permissions to ALL your projects on this chain, not just one.');

    executeTransaction({
      ...buildSetPermissionsArgs({ chainId: state.chainId, permissionsAddr: permissionsAddr, account: account, operator: state.operator, projectId: projectId, permissionIds: selectedArr }),
      confirmDescription: danger.join(' ') || undefined,
      onStatus: function(msg) { state.txStatus = { message: msg, success: false }; updateUI(); },
      onSuccess: function(msg) { state.txStatus = { message: msg, success: true }; updateUI(); },
      onError: function(msg) { state.error = msg; state.txStatus = null; updateUI(); },
    });
  }

  updateUI();
  return wrapper;
}
