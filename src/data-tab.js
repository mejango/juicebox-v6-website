// src/data-tab.js
// Renders the DATA tab — a catalog of Bendystraw GraphQL queries.
// Visually mirrors the ACTIONS tab: section-header.transact + collapsible fn-row cards.

import queries from '../data/bendystraw-queries.json';
import { bendystrawQuery, renderBendystrawSettings } from './bendystraw-client.js';
import { FORMATTERS } from './bendystraw-format.js';
import { getManifestChains } from './chain.js';

// DATA-tab chain picker follows the Discover network toggle (jb-network), like the rest of the app.
// Mainnet → mainnet chains (default Ethereum); testnet → testnet chains (default Sepolia).
function wantTestnet() {
  try { return localStorage.getItem('jb-network') === 'testnet'; } catch (_) { return false; }
}
function defaultBendystrawChainId() { return wantTestnet() ? 11155111 : 1; }
function inActiveNetwork(chain) { return chain && !!chain.testnet === wantTestnet(); }

function bendystrawChains() {
  const chains = getManifestChains();
  return Object.keys(chains)
    .filter(cid => inActiveNetwork(chains[cid]))
    .map(cid => ({ id: cid, chain: chains[cid] }));
}

export function renderDataTab() {
  const container = document.getElementById('tab-data');
  if (!container) return;
  container.innerHTML = '';

  // Compact settings strip at the top. (No Pinata field — the Create flow pins via a baked-in scoped key.)
  container.appendChild(renderBendystrawSettings());

  // Sections, identical structure to ACTIONS.
  for (const section of queries.sections) {
    const header = document.createElement('div');
    header.className = 'section-header transact';
    header.textContent = section.title.toUpperCase();
    container.appendChild(header);

    for (const q of section.queries) {
      container.appendChild(renderQueryRow(q));
    }
  }
}

function renderQueryRow(q) {
  const row = document.createElement('div');
  row.className = 'fn-row data-row';

  // Summary (clickable header) — same DOM shape as renderFunctionRow.
  const summary = document.createElement('div');
  summary.className = 'fn-summary';

  const arrow = document.createElement('span');
  arrow.className = 'fn-arrow';
  arrow.textContent = '▸';
  summary.appendChild(arrow);

  const name = document.createElement('span');
  name.className = 'fn-name-preview read';
  name.textContent = q.title;
  summary.appendChild(name);

  const sourceHint = document.createElement('span');
  sourceHint.className = 'fn-contract-hint';
  sourceHint.textContent = 'Bendystraw';
  summary.appendChild(sourceHint);

  if (q.hint) {
    const hint = document.createElement('span');
    hint.className = 'fn-hint';
    hint.textContent = q.hint;
    summary.appendChild(hint);
  }

  row.appendChild(summary);

  let expanded = false;
  let content = null;

  summary.addEventListener('click', () => {
    expanded = !expanded;
    arrow.textContent = expanded ? '▾' : '▸';
    if (expanded && !content) {
      content = buildContent(q);
      row.appendChild(content);
    }
    if (content) content.style.display = expanded ? '' : 'none';
  });

  return row;
}

function buildContent(q) {
  const wrap = document.createElement('div');
  wrap.className = 'function-form data-row-content';

  // Inputs — vertically stacked, full width, mirrors form.js .fn-inputs.
  const inputContainer = document.createElement('div');
  inputContainer.className = 'fn-inputs';
  const fields = {};

  // Detect (projectId int, required, singular) + (chainId chain, required, singular).
  // Render them as the paired widget used in the COMPONENTS-tab pretty forms.
  const visible = (q.variables || []).filter(v => !v.hidden);
  const projectVar = visible.find(v => v.name === 'projectId' && v.type === 'int' && !v.optional);
  const chainVar = visible.find(v => v.name === 'chainId' && v.type === 'chain' && !v.optional);
  const paired = !!(projectVar && chainVar);

  if (paired) {
    inputContainer.appendChild(renderProjectAndChainPair(projectVar, chainVar, fields));
  }

  for (const v of visible) {
    if (paired && (v === projectVar || v === chainVar)) continue;
    const group = document.createElement('div');
    group.className = 'input-group';

    const label = document.createElement('label');
    label.className = 'input-label';
    // Type names like int/chain/chains aren't useful in the data tab — variable
    // names are self-explanatory. Only surface "optional" when relevant.
    const showOptional = v.optional && v.type !== 'chain_multi';
    label.innerHTML = showOptional
      ? `${v.name} <span class="type-hint">optional</span>`
      : v.name;
    group.appendChild(label);

    let input;
    if (v.type === 'chain') {
      input = renderChainPills(v);
    } else if (v.type === 'chain_multi') {
      input = renderChainMultiPills(v);
    } else {
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'field' + (v.type === 'int' || v.type === 'bigint' ? ' numeric-field' : v.type === 'address' ? ' address-field' : ' string-field');
      input.placeholder = v.default != null ? String(v.default) : '';
      if (v.default != null) input.value = String(v.default);
    }
    group.appendChild(input);
    fields[v.name] = { input, def: v };
    inputContainer.appendChild(group);
  }
  wrap.appendChild(inputContainer);

  // Actions row (mirrors form.js .fn-actions).
  const actions = document.createElement('div');
  actions.className = 'fn-actions';

  const runBtn = document.createElement('button');
  runBtn.className = 'btn btn-transact data-run-btn';
  runBtn.textContent = 'QUERY';
  actions.appendChild(runBtn);

  const status = document.createElement('span');
  status.className = 'data-card-status';
  actions.appendChild(status);

  wrap.appendChild(actions);

  // Result panel.
  const resultPanel = document.createElement('div');
  resultPanel.className = 'data-card-result';
  wrap.appendChild(resultPanel);

  // Per-card state for paging.
  const state = { offset: 0, items: [], totalCount: null };

  const collectVars = (extraOffset) => {
    const vars = {};
    for (const v of (q.variables || [])) {
      const f = fields[v.name];
      let raw;
      if (v.hidden) {
        raw = v.name === 'offset' && extraOffset != null ? String(extraOffset) : (v.default != null ? String(v.default) : '');
      } else {
        raw = f && f.input ? (typeof f.input.getValue === 'function' ? f.input.getValue() : (f.input.value != null ? f.input.value : '')) : '';
      }
      raw = String(raw).trim();
      if (raw === '') {
        if (v.optional) continue;
        continue;
      }
      vars[v.name] = coerce(raw, v.type);
    }
    return vars;
  };

  const renderItems = (items, append) => {
    if (!append) resultPanel.innerHTML = '';
    if (!items || items.length === 0) {
      if (!append) {
        const empty = document.createElement('div');
        empty.className = 'data-empty';
        empty.textContent = 'No results.';
        resultPanel.appendChild(empty);
      }
      return;
    }
    let table = resultPanel.querySelector('table.data-result-table');
    if (!table) {
      table = document.createElement('table');
      table.className = 'data-result-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const col of q.columns) {
        const th = document.createElement('th');
        th.textContent = col.label;
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      table.appendChild(tbody);
      resultPanel.appendChild(table);
    }
    const tbody = table.querySelector('tbody');
    for (const item of items) {
      const tr = document.createElement('tr');
      for (const col of q.columns) {
        const td = document.createElement('td');
        const value = item ? item[col.key] : null;
        const fmt = FORMATTERS[col.format] || FORMATTERS.text;
        td.appendChild(fmt(value, item));
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  };

  const renderSingle = (obj) => {
    resultPanel.innerHTML = '';
    if (obj == null) {
      const empty = document.createElement('div');
      empty.className = 'data-empty';
      empty.textContent = 'Not found.';
      resultPanel.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'data-result-table single';
    const tbody = document.createElement('tbody');
    for (const col of q.columns) {
      const tr = document.createElement('tr');
      const th = document.createElement('th');
      th.textContent = col.label;
      tr.appendChild(th);
      const td = document.createElement('td');
      const value = obj[col.key];
      const fmt = FORMATTERS[col.format] || FORMATTERS.text;
      td.appendChild(fmt(value, obj));
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    resultPanel.appendChild(table);
  };

  const run = async (loadMore) => {
    runBtn.disabled = true;
    status.textContent = loadMore ? 'loading more…' : 'querying…';
    status.classList.remove('error');
    try {
      const offsetForRun = loadMore ? state.offset : 0;
      const vars = collectVars(offsetForRun);

      // Resolve (projectId, chainId) → suckerGroupId for queries that work
      // across the whole sucker group. The user never types the group ID.
      if (q.resolveSuckerGroup) {
        const projectId = vars.projectId;
        const chainId = vars.chainId;
        if (projectId == null || chainId == null) throw new Error('projectId and chainId are required');
        status.textContent = 'resolving sucker group…';
        const groupData = await bendystrawQuery(
          'query($projectId: Float!, $chainId: Float!) { project(projectId: $projectId, chainId: $chainId) { suckerGroupId } }',
          { projectId, chainId }
        );
        const project = groupData && groupData.project;
        if (!project) throw new Error(`No project ${projectId} on chain ${chainId}`);
        if (!project.suckerGroupId) throw new Error(`Project ${projectId} on chain ${chainId} has no sucker group`);
        vars.suckerGroupId = project.suckerGroupId;
        delete vars.projectId;
        delete vars.chainId;
        status.textContent = loadMore ? 'loading more…' : 'querying…';
      }

      const data = await bendystrawQuery(q.query, vars);
      const node = data ? data[q.path] : null;
      if (q.kind === 'single') {
        renderSingle(node);
        status.textContent = node ? 'ok' : 'not found';
      } else {
        const items = (node && node.items) || [];
        const total = node && node.totalCount != null ? node.totalCount : null;
        if (!loadMore) state.items = [];
        state.items = state.items.concat(items);
        state.offset = state.items.length;
        state.totalCount = total;
        renderItems(items, loadMore);

        const existingMore = resultPanel.querySelector('.data-load-more');
        if (existingMore) existingMore.remove();
        const summary = `${state.items.length} shown${total != null ? ' / ' + total.toLocaleString() + ' total' : ''}`;
        status.textContent = summary;
        const limitField = fields.limit && fields.limit.input;
        const limit = limitField ? parseInt(limitField.value || '0', 10) : 0;
        const couldHaveMore = items.length > 0 && (total == null || state.items.length < total) && limit > 0 && items.length >= limit;
        if (couldHaveMore) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'btn btn-transact data-load-more';
          more.textContent = 'Load more';
          more.addEventListener('click', () => run(true));
          resultPanel.appendChild(more);
        }
      }
    } catch (err) {
      status.textContent = 'error: ' + (err && err.message ? err.message : String(err));
      status.classList.add('error');
    } finally {
      runBtn.disabled = false;
    }
  };

  runBtn.addEventListener('click', () => run(false));

  return wrap;
}

// Multi-select chain picker. Pills toggle on/off independently.
// `.getValue()` returns a comma-separated list of chain IDs, or "" when none.
// Empty selection means "all chains in the active network" — no chainId_in filter.
function renderChainMultiPills(varDef) {
  const wrapper = document.createElement('div');
  wrapper.className = 'fn-chain-selector data-chain-selector data-chain-multi';

  const chains = getManifestChains();
  const chainEntries = bendystrawChains();
  const allTestnetChainIds = chainEntries.map(entry => Number(entry.id));
  const selected = new Set();

  function render() {
    wrapper.innerHTML = '';

    const pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';
    for (const { id: cid, chain: ch } of chainEntries) {
      const idNum = Number(cid);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (selected.has(idNum) ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.addEventListener('click', () => {
        if (selected.has(idNum)) selected.delete(idNum); else selected.add(idNum);
        render();
      });
      pillsRow.appendChild(pill);
    }

    // "all" pseudo-pill: clears selection (means: no chain filter).
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    allBtn.className = 'chain-pill' + (selected.size === 0 ? ' selected' : '');
    allBtn.textContent = 'all';
    allBtn.title = 'search all chains in the active network';
    allBtn.addEventListener('click', () => { selected.clear(); render(); });
    pillsRow.appendChild(allBtn);

    wrapper.appendChild(pillsRow);
  }

  render();
  wrapper.getValue = () => (selected.size ? Array.from(selected) : allTestnetChainIds).join(',');
  Object.defineProperty(wrapper, 'value', { get() { return (selected.size ? Array.from(selected) : allTestnetChainIds).join(','); } });
  return wrapper;
}

// Paired (projectId + chainId) widget mirroring the COMPONENTS-tab pattern:
// the chain summary sits ABOVE the projectId input as a collapsed "▸ on <chain>"
// link that expands into a full chain picker on click.
// Side effect: registers `projectId` and `chainId` entries in `fields` so the
// outer collectVars() can read them.
function renderProjectAndChainPair(projectVar, chainVar, fields) {
  const section = document.createElement('div');
  section.className = 'input-group project-chain-pair project-chain-section';

  const label = document.createElement('label');
  label.className = 'input-label';
  label.textContent = projectVar.name;
  section.appendChild(label);

  const chains = getManifestChains();
  const chainEntries = bendystrawChains();
  const defaultChain = chainVar.default != null ? Number(chainVar.default) : null;
  let selectedChain = defaultChain != null && inActiveNetwork(chains[String(defaultChain)])
    ? defaultChain
    : defaultBendystrawChainId();
  let showPicker = false;

  const chainWrap = document.createElement('div');
  chainWrap.className = 'project-chain-wrap';

  const summary = document.createElement('a');
  summary.className = 'project-chain-summary';
  summary.href = '#';
  chainWrap.appendChild(summary);

  const picker = document.createElement('div');
  picker.className = 'project-chain-picker';
  chainWrap.appendChild(picker);

  function renderPicker() {
    picker.innerHTML = '';
    picker.style.display = showPicker ? '' : 'none';
    if (!showPicker) return;

    const pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';
    for (const { id: cid, chain: ch } of chainEntries) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (Number(cid) === selectedChain ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.addEventListener('click', (e) => {
        selectedChain = Number(e.currentTarget.dataset.chainId);
        showPicker = false;
        renderSummary();
        renderPicker();
      });
      pillsRow.appendChild(pill);
    }
    picker.appendChild(pillsRow);
  }

  function renderSummary() {
    const ch = chains[String(selectedChain)];
    const name = ch ? ch.name : 'select chain';
    summary.textContent = (showPicker ? '▾' : '▸') + ' on ' + name;
  }

  summary.addEventListener('click', (e) => {
    e.preventDefault();
    showPicker = !showPicker;
    renderSummary();
    renderPicker();
  });

  renderSummary();
  renderPicker();
  section.appendChild(chainWrap);

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'field numeric-field';
  idInput.placeholder = projectVar.default != null ? String(projectVar.default) : '';
  if (projectVar.default != null) idInput.value = String(projectVar.default);
  section.appendChild(idInput);

  // Expose the chain value to collectVars via a stub element with getValue().
  const chainProxy = { getValue: () => String(selectedChain), get value() { return String(selectedChain); } };

  fields[projectVar.name] = { input: idInput, def: projectVar };
  fields[chainVar.name] = { input: chainProxy, def: chainVar };

  return section;
}

// Replicates form.js renderFormChainSelector but as an embeddable input.
// Returns an element with `.getValue()` returning the selected chainId as a string.
function renderChainPills(varDef) {
  const wrapper = document.createElement('div');
  wrapper.className = 'fn-chain-selector data-chain-selector';

  const chains = getManifestChains();
  const chainEntries = bendystrawChains();
  const defaultVal = varDef.default != null ? Number(varDef.default) : null;
  let selectedChain = defaultVal != null && inActiveNetwork(chains[String(defaultVal)])
    ? defaultVal
    : null;

  function render() {
    wrapper.innerHTML = '';

    const pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';
    for (const { id: cid, chain: ch } of chainEntries) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (Number(cid) === selectedChain ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.addEventListener('click', (e) => {
        selectedChain = Number(e.currentTarget.dataset.chainId);
        render();
      });
      pillsRow.appendChild(pill);
    }

    if (varDef.optional) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'chain-pill' + (selectedChain == null ? ' selected' : '');
      clearBtn.textContent = 'any';
      clearBtn.addEventListener('click', () => { selectedChain = null; render(); });
      pillsRow.appendChild(clearBtn);
    }

    wrapper.appendChild(pillsRow);
  }

  render();
  wrapper.getValue = () => (selectedChain != null ? String(selectedChain) : '');
  Object.defineProperty(wrapper, 'value', { get() { return selectedChain != null ? String(selectedChain) : ''; } });
  return wrapper;
}

function coerce(value, type) {
  switch (type) {
    case 'int':
    case 'chain':
      return parseInt(value, 10);
    case 'chain_multi':
      // value is a comma-separated list of chain IDs from renderChainMultiPills.
      return String(value).split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n));
    case 'bigint':
      return value;
    case 'address':
      return value.toLowerCase();
    case 'string':
    default:
      return value;
  }
}
