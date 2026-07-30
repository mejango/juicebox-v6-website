import { el } from './component-base.js';
import {
  DURATION_PRESETS,
  createDefaultSplit,
  createDefaultSplitGroup,
  createDefaultPayoutLimit,
  createDefaultSurplusAllowance,
  createDefaultFundAccessLimitGroup,
} from './ruleset-config.js';

export function renderRulesetFieldset(rs, index, state, updateUI, opts) {
  opts = opts || {};
  var rsFieldset = el('div', 'config-fieldset');
  var header = el('div', 'ruleset-header');
  var rsTitle = el('span', 'nested-index');
  rsTitle.textContent = '#' + (index + 1);
  header.appendChild(rsTitle);
  if (index > 0) {
    var removeBtn = el('button', 'ruleset-remove');
    removeBtn.type = 'button';
    removeBtn.textContent = 'remove';
    removeBtn.addEventListener('click', function() {
      state.rulesets.splice(index, 1);
      updateUI();
    });
    header.appendChild(removeBtn);
  }
  rsFieldset.appendChild(header);

  if (opts.includeStartAt) {
    rsFieldset.appendChild(configRow('start at or after', 'unix timestamp, 0 = now', rs, 'mustStartAtOrAfter'));
  }
  rsFieldset.appendChild(durationRow(rs, updateUI));
  rsFieldset.appendChild(currencyPills(rs, updateUI));
  rsFieldset.appendChild(configRow(
    'issuance rate',
    opts.weightHint || ('tokens per ' + baseCurrencyLabel(rs)),
    rs,
    'weight',
    opts.weightPlaceholder || '1000000'
  ));
  rsFieldset.appendChild(percentSlider('decay rate', rs, 'weightCutPercent', 100));
  rsFieldset.appendChild(percentSlider('reserved rate', rs, 'reservedPercent', 100));
  rsFieldset.appendChild(percentSlider('cash out tax rate', rs, 'cashOutTaxRate', 100));

  rsFieldset.appendChild(collapsibleSection('\u25B8 Splits', '\u25BE Splits', rs, 'splitsExpanded', updateUI, function() {
    return renderSplitGroupsEditor(rs, updateUI);
  }));
  rsFieldset.appendChild(collapsibleSection('\u25B8 Fund access limits', '\u25BE Fund access limits', rs, 'fundAccessExpanded', updateUI, function() {
    return renderFundAccessEditor(rs, updateUI);
  }));
  rsFieldset.appendChild(collapsibleSection('\u25B8 Flags', '\u25BE Flags', rs, 'flagsExpanded', updateUI, function() {
    var wrap = el('div', '');
    wrap.appendChild(configCheckbox('Pause payments', rs, 'pausePay'));
    wrap.appendChild(configCheckbox('Pause credit transfers', rs, 'pauseCreditTransfers'));
    wrap.appendChild(configCheckbox('Allow owner minting', rs, 'allowOwnerMinting'));
    wrap.appendChild(configCheckbox('Allow set custom token', rs, 'allowSetCustomToken'));
    wrap.appendChild(configCheckbox('Allow terminal migration', rs, 'allowTerminalMigration'));
    wrap.appendChild(configCheckbox('Allow set terminals', rs, 'allowSetTerminals'));
    wrap.appendChild(configCheckbox('Allow set controller', rs, 'allowSetController'));
    wrap.appendChild(configCheckbox('Allow add accounting context', rs, 'allowAddAccountingContext'));
    wrap.appendChild(configCheckbox('Allow add price feed', rs, 'allowAddPriceFeed'));
    wrap.appendChild(configCheckbox('Project owner must send payouts', rs, 'ownerMustSendPayouts'));
    wrap.appendChild(configCheckbox('Hold fees', rs, 'holdFees'));
    wrap.appendChild(configCheckbox('Use total surplus for cash outs', rs, 'useTotalSurplusForCashOuts'));
    wrap.appendChild(configCheckbox('Use data hook for pay', rs, 'useDataHookForPay'));
    wrap.appendChild(configCheckbox('Use data hook for cash out', rs, 'useDataHookForCashOut'));
    return wrap;
  }));
  rsFieldset.appendChild(collapsibleSection('\u25B8 Advanced', '\u25BE Advanced', rs, 'advancedExpanded', updateUI, function() {
    var wrap = el('div', '');
    wrap.appendChild(addressRow('approval hook', rs, 'approvalHook'));
    wrap.appendChild(addressRow('data hook', rs, 'dataHook'));
    wrap.appendChild(configRow('metadata (uint16)', 'extra metadata bits', rs, 'metadataExtra', '0'));
    return wrap;
  }));

  return rsFieldset;
}

function collapsibleSection(collapsedLabel, expandedLabel, rs, key, updateUI, renderContent) {
  var wrap = el('div', '');
  var toggle = el('div', 'config-fieldset-title');
  toggle.style.cursor = 'pointer';
  toggle.style.marginTop = '8px';
  toggle.textContent = rs[key] ? expandedLabel : collapsedLabel;
  toggle.addEventListener('click', function() {
    rs[key] = !rs[key];
    updateUI();
  });
  wrap.appendChild(toggle);
  if (rs[key]) wrap.appendChild(renderContent());
  return wrap;
}

function renderSplitGroupsEditor(rs, updateUI) {
  var wrap = el('div', 'nested-editor');
  for (var gi = 0; gi < rs.splitGroups.length; gi++) {
    (function(gIdx) {
      var group = rs.splitGroups[gIdx];
      var groupEl = el('div', 'nested-group');
      var groupHeader = el('div', 'nested-group-header');
      var groupTitle = el('span', 'nested-index');
      groupTitle.textContent = '#' + (gIdx + 1);
      groupHeader.appendChild(groupTitle);
      var removeGroupBtn = el('button', 'ruleset-remove');
      removeGroupBtn.type = 'button';
      removeGroupBtn.textContent = 'remove';
      removeGroupBtn.addEventListener('click', function() {
        rs.splitGroups.splice(gIdx, 1);
        updateUI();
      });
      groupHeader.appendChild(removeGroupBtn);
      groupEl.appendChild(groupHeader);
      groupEl.appendChild(configRow('group ID', 'uint256 (token address as number)', group, 'groupId'));

      for (var si = 0; si < group.splits.length; si++) {
        (function(sIdx) {
          var split = group.splits[sIdx];
          var splitEl = el('div', 'nested-item');
          var splitHeader = el('div', 'nested-item-header');
          var splitTitle = el('span', 'nested-index');
          splitTitle.textContent = '#' + (sIdx + 1);
          splitHeader.appendChild(splitTitle);
          if (group.splits.length > 1) {
            var removeSplitBtn = el('button', 'ruleset-remove');
            removeSplitBtn.type = 'button';
            removeSplitBtn.textContent = '✕';
            removeSplitBtn.addEventListener('click', function() {
              group.splits.splice(sIdx, 1);
              updateUI();
            });
            splitHeader.appendChild(removeSplitBtn);
          }
          splitEl.appendChild(splitHeader);
          splitEl.appendChild(splitPercentRow(split));
          splitEl.appendChild(addressRow('beneficiary', split, 'beneficiary'));
          splitEl.appendChild(configRow('project ID', 'optional, routes to project', split, 'projectId'));
          splitEl.appendChild(lockedUntilRow(split));
          splitEl.appendChild(addressRow('hook', split, 'hook'));
          splitEl.appendChild(configCheckbox('Prefer add to balance', split, 'preferAddToBalance'));
          groupEl.appendChild(splitEl);
        })(si);
      }

      var addSplitBtn = el('button', 'add-nested-btn');
      addSplitBtn.type = 'button';
      addSplitBtn.textContent = '+ split';
      addSplitBtn.addEventListener('click', function() {
        group.splits.push(createDefaultSplit());
        updateUI();
      });
      groupEl.appendChild(addSplitBtn);
      wrap.appendChild(groupEl);
    })(gi);
  }

  var addGroupBtn = el('button', 'add-nested-btn');
  addGroupBtn.type = 'button';
  addGroupBtn.textContent = '+ Add split group';
  addGroupBtn.addEventListener('click', function() {
    rs.splitGroups.push(createDefaultSplitGroup());
    updateUI();
  });
  wrap.appendChild(addGroupBtn);
  return wrap;
}

function renderFundAccessEditor(rs, updateUI) {
  var wrap = el('div', 'nested-editor');
  for (var gi = 0; gi < rs.fundAccessLimitGroups.length; gi++) {
    (function(gIdx) {
      var group = rs.fundAccessLimitGroups[gIdx];
      var groupEl = el('div', 'nested-group');
      var groupHeader = el('div', 'nested-group-header');
      var groupTitle = el('span', 'nested-index');
      groupTitle.textContent = '#' + (gIdx + 1);
      groupHeader.appendChild(groupTitle);
      var removeGroupBtn = el('button', 'ruleset-remove');
      removeGroupBtn.type = 'button';
      removeGroupBtn.textContent = 'remove';
      removeGroupBtn.addEventListener('click', function() {
        rs.fundAccessLimitGroups.splice(gIdx, 1);
        updateUI();
      });
      groupHeader.appendChild(removeGroupBtn);
      groupEl.appendChild(groupHeader);
      groupEl.appendChild(addressRow('terminal', group, 'terminal'));
      groupEl.appendChild(addressRow('token', group, 'token'));

      appendFundAccessSection(groupEl, 'Payout limits', group.payoutLimits, 'payout limit', function() {
        group.payoutLimits.push(createDefaultPayoutLimit());
      }, updateUI, 'uint224 fixed-point in terminal token decimals (e.g. 18 for ETH, 6 for USDC; use max for unlimited)');
      appendFundAccessSection(groupEl, 'Surplus allowances', group.surplusAllowances, 'surplus allowance', function() {
        group.surplusAllowances.push(createDefaultSurplusAllowance());
      }, updateUI, 'uint224 fixed-point in terminal token decimals (e.g. 18 for ETH, 6 for USDC)');
      wrap.appendChild(groupEl);
    })(gi);
  }

  var addGroupBtn = el('button', 'add-nested-btn');
  addGroupBtn.type = 'button';
  addGroupBtn.textContent = '+ Add fund access limit group';
  addGroupBtn.addEventListener('click', function() {
    rs.fundAccessLimitGroups.push(createDefaultFundAccessLimitGroup());
    updateUI();
  });
  wrap.appendChild(addGroupBtn);
  return wrap;
}

function appendFundAccessSection(groupEl, title, rows, singular, addRow, updateUI, amountHint) {
  var sectionTitle = el('div', 'type-hint');
  sectionTitle.textContent = title;
  sectionTitle.style.marginTop = '6px';
  sectionTitle.style.marginBottom = '4px';
  sectionTitle.style.fontWeight = 'bold';
  groupEl.appendChild(sectionTitle);
  for (var i = 0; i < rows.length; i++) {
    (function(idx) {
      var st = rows[idx];
      var rowEl = el('div', 'nested-item');
      var header = el('div', 'nested-item-header');
      var label = el('span', 'nested-index');
      label.textContent = '#' + (idx + 1);
      header.appendChild(label);
      if (rows.length > 1) {
        var removeBtn = el('button', 'ruleset-remove');
        removeBtn.type = 'button';
        removeBtn.textContent = '✕';
        removeBtn.addEventListener('click', function() {
          rows.splice(idx, 1);
          updateUI();
        });
        header.appendChild(removeBtn);
      }
      rowEl.appendChild(header);
      rowEl.appendChild(configRow('amount', amountHint, st, 'amount'));
      rowEl.appendChild(fundCurrencyRow(st, updateUI));
      groupEl.appendChild(rowEl);
    })(i);
  }
  var addBtn = el('button', 'add-nested-btn');
  addBtn.type = 'button';
  addBtn.textContent = '+ ' + singular;
  addBtn.addEventListener('click', function() {
    addRow();
    updateUI();
  });
  groupEl.appendChild(addBtn);
}

function durationRow(rs, updateUI) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.textContent = 'duration';
  row.appendChild(lbl);
  var sel = el('select', 'field');
  sel.style.maxWidth = '180px';
  for (var i = 0; i < DURATION_PRESETS.length; i++) {
    var opt = document.createElement('option');
    opt.value = DURATION_PRESETS[i].seconds;
    opt.textContent = DURATION_PRESETS[i].label;
    if (rs.durationPreset === DURATION_PRESETS[i].seconds) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', function() {
    rs.durationPreset = Number(sel.value);
    updateUI();
  });
  row.appendChild(sel);
  if (rs.durationPreset === -1) {
    var custom = el('input', 'field numeric-field');
    custom.type = 'text';
    custom.placeholder = 'seconds';
    custom.value = rs.durationCustom;
    custom.style.maxWidth = '100px';
    custom.addEventListener('input', function() { rs.durationCustom = custom.value.trim(); });
    row.appendChild(custom);
  }
  return row;
}

function lockedUntilRow(split) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  var tz;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'; } catch (_) { tz = 'local'; }
  lbl.innerHTML = 'locked until <span class="type-hint">' + tz + '</span>';
  row.appendChild(lbl);
  var input = el('input', 'field datetime-field');
  input.type = 'datetime-local';
  input.value = tsToLocalInput(split.lockedUntil);
  input.addEventListener('input', function() {
    if (!input.value) { split.lockedUntil = 0; return; }
    var d = new Date(input.value);
    split.lockedUntil = isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
  });
  row.appendChild(input);
  var clearLink = document.createElement('button');
  clearLink.type = 'button';
  clearLink.className = 'datetime-clear';
  clearLink.textContent = 'clear';
  clearLink.addEventListener('click', function(e) {
    e.preventDefault();
    split.lockedUntil = 0;
    input.value = '';
  });
  row.appendChild(clearLink);
  return row;
}

function tsToLocalInput(ts) {
  var n = Number(ts || 0);
  if (!n) return '';
  var d = new Date(n * 1000);
  if (isNaN(d.getTime())) return '';
  var pad = function(x) { return x < 10 ? '0' + x : '' + x; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function splitPercentRow(split) {
  var SPLITS_MAX = 1000000000;
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.innerHTML = 'percent <span class="type-hint">share of group</span>';
  row.appendChild(lbl);
  var slider = el('input', 'config-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '100';
  slider.step = '0.5';
  var currentPct = (Number(split.percent || 0) / SPLITS_MAX) * 100;
  slider.value = currentPct;
  var valInput = el('input', 'config-slider-input');
  valInput.type = 'text';
  valInput.value = (Math.round(currentPct * 100) / 100).toString();
  var suffix = el('span', 'config-percent-suffix');
  suffix.textContent = '%';
  function commit(pct) {
    var raw = Math.round((pct / 100) * SPLITS_MAX);
    if (raw < 0) raw = 0;
    if (raw > SPLITS_MAX) raw = SPLITS_MAX;
    split.percent = raw;
  }
  slider.addEventListener('input', function() {
    var pct = Number(slider.value);
    commit(pct);
    valInput.value = (Math.round(pct * 100) / 100).toString();
  });
  valInput.addEventListener('input', function() {
    var v = parseFloat(valInput.value);
    if (!isNaN(v) && v >= 0 && v <= 100) {
      commit(v);
      slider.value = String(v);
    }
  });
  valInput.addEventListener('blur', function() {
    var pct = (Number(split.percent || 0) / SPLITS_MAX) * 100;
    valInput.value = (Math.round(pct * 100) / 100).toString();
  });
  row.appendChild(slider);
  row.appendChild(valInput);
  row.appendChild(suffix);
  return row;
}

export function percentSlider(label, rs, key, max) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.textContent = label;
  row.appendChild(lbl);
  var slider = el('input', 'config-slider');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(max);
  slider.step = '0.5';
  slider.value = rs[key];
  var valInput = el('input', 'config-slider-input');
  valInput.type = 'text';
  valInput.value = rs[key];
  var suffix = el('span', 'config-percent-suffix');
  suffix.textContent = '%';
  slider.addEventListener('input', function() {
    rs[key] = Number(slider.value);
    valInput.value = slider.value;
  });
  valInput.addEventListener('input', function() {
    var v = parseFloat(valInput.value);
    if (!isNaN(v) && v >= 0 && v <= max) {
      rs[key] = v;
      slider.value = v;
    }
  });
  valInput.addEventListener('blur', function() {
    valInput.value = rs[key];
  });
  row.appendChild(slider);
  row.appendChild(valInput);
  row.appendChild(suffix);
  return row;
}

function currencyPills(rs, updateUI) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.textContent = 'base currency';
  row.appendChild(lbl);
  var pills = el('div', 'currency-pills');
  var opts = [{ val: 1, label: 'ETH' }, { val: 2, label: 'USD' }];
  for (var i = 0; i < opts.length; i++) {
    (function(o) {
      var pill = el('button', 'pill' + (rs.baseCurrency === o.val ? ' selected' : ''));
      pill.type = 'button';
      pill.textContent = o.label;
      pill.addEventListener('click', function() { rs.baseCurrency = o.val; updateUI(); });
      pills.appendChild(pill);
    })(opts[i]);
  }
  row.appendChild(pills);
  return row;
}

function baseCurrencyLabel(rs) {
  return Number(rs.baseCurrency) === 2 ? 'USD' : 'ETH';
}

function fundCurrencyRow(st, updateUI) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.innerHTML = 'currency <span class="type-hint">denomination (ETH = 1, USD = 2; price feed converts to the terminal token at withdrawal)</span>';
  row.appendChild(lbl);
  var pills = el('div', 'currency-pills');
  var current = Number(st.currency);
  var isCustom = current !== 1 && current !== 2;
  var opts = [{ val: 1, label: 'ETH' }, { val: 2, label: 'USD' }, { val: 'custom', label: 'Custom' }];
  for (var i = 0; i < opts.length; i++) {
    (function(o) {
      var selected = o.val === 'custom' ? isCustom : Number(st.currency) === o.val;
      var pill = el('button', 'pill' + (selected ? ' selected' : ''));
      pill.type = 'button';
      pill.textContent = o.label;
      pill.addEventListener('click', function() {
        if (o.val === 'custom') {
          if (!isCustom) st.currency = '';
        } else {
          st.currency = o.val;
        }
        updateUI();
      });
      pills.appendChild(pill);
    })(opts[i]);
  }
  row.appendChild(pills);
  if (isCustom) {
    var input = el('input', 'field numeric-field');
    input.type = 'text';
    input.placeholder = 'uint32 currency id';
    input.value = st.currency || '';
    input.addEventListener('input', function() { st.currency = input.value.trim(); });
    row.appendChild(input);
  }
  return row;
}

export function configRow(label, hint, st, key, placeholder) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.innerHTML = label + ' <span class="type-hint">' + hint + '</span>';
  row.appendChild(lbl);
  var input = el('input', 'field numeric-field' + (/optional/i.test(hint || '') ? ' optional-field' : ''));
  input.type = 'text';
  input.placeholder = placeholder || '0';
  input.value = st[key];
  input.addEventListener('input', function() { st[key] = input.value.trim(); });
  row.appendChild(input);
  return row;
}

function addressRow(label, st, key) {
  var row = el('div', 'config-row');
  var lbl = el('label', 'input-label');
  lbl.textContent = label;
  row.appendChild(lbl);
  var input = el('input', 'field address-field');
  input.type = 'text';
  input.placeholder = '0x0000...0000';
  input.value = st[key];
  input.addEventListener('input', function() { st[key] = input.value.trim(); });
  row.appendChild(input);
  return row;
}

function configCheckbox(label, st, key) {
  var row = el('label', 'config-row-checkbox');
  var cb = el('input', '');
  cb.type = 'checkbox';
  cb.checked = st[key];
  cb.addEventListener('change', function() { st[key] = cb.checked; });
  row.appendChild(cb);
  row.appendChild(document.createTextNode(label));
  return row;
}
