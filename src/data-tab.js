// src/data-tab.js
// Renders the DATA tab — a catalog of Bendystraw GraphQL queries.
// Visually mirrors the ACTIONS tab: section-header.transact + collapsible fn-row cards.

import queries from '../data/bendystraw-queries.json';
import { bendystrawQuery, getBendystrawNetwork, renderBendystrawSettings } from './bendystraw-client.js';
import { FORMATTERS } from './bendystraw-format.js';
import { getManifestChains } from './chain.js';
import { setDiscoverNetwork } from './discover.js';
import { copyPlainText } from './component-base.js';
import { isAddress } from 'viem';

// DATA-tab chain picker follows the Discover network toggle (jb-network), like the rest of the app.
// Mainnet → mainnet chains (default Ethereum); testnet → testnet chains (default Sepolia).
function wantTestnet() {
  return getBendystrawNetwork() === 'testnet';
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
  container.appendChild(renderBendystrawSettings({ onNetworkChange: function (mode) {
    // Keep Discover's chain list/cache in lock-step when the shared toggle is changed from this tab.
    setDiscoverNetwork(mode);
    renderDataTab();
  } }));

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

// RFC-4180-style CSV of the current result rows: q.columns order, labels as the header row, raw item
// values as cells (objects serialize as JSON). Pure — the download button wraps it in a Blob.
export function dataRowsToCsv(columns, items) {
  function cell(value) {
    if (value == null) value = '';
    value = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  }
  const lines = [(columns || []).map(col => cell(col.label)).join(',')];
  for (const item of (items || [])) {
    lines.push((columns || []).map(col => cell(item ? item[col.key] : '')).join(','));
  }
  return lines.join('\r\n');
}

function csvDownloadButton(q, getRows) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-transact data-csv-btn';
  btn.textContent = 'DOWNLOAD CSV';
  btn.title = 'Save the rows currently shown as a .csv file';
  btn.addEventListener('click', () => {
    const blob = new Blob([dataRowsToCsv(q.columns, getRows())], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = String(q.id || q.title || 'results').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.csv';
    document.body.appendChild(a);
    a.click();
    // Keep the anchor + object URL alive long enough for the browser to begin the download (Safari).
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 2000);
  });
  return btn;
}

// The tab renders once at init, so follow the shared network toggle wherever it's flipped (the Discover
// header, this tab's own strip) — otherwise the endpoint note and chain pills keep the stale network.
if (typeof document !== 'undefined') {
  document.addEventListener('jb:network-changed', function () { renderDataTab(); });
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
    // `chainIds` is a result filter, not the chain which scopes projectId. Give
    // both controls explicit human labels and selection semantics so they cannot
    // be mistaken for one another.
    const isResultChains = v.type === 'chain_multi' && v.name === 'chainIds';
    const showOptional = v.optional && !isResultChains;
    const labelText = isResultChains ? 'Result chains' : v.name;
    const labelHint = isResultChains ? 'select one or more' : (showOptional ? 'optional' : '');
    label.textContent = labelText;
    if (labelHint) {
      const hint = document.createElement('span');
      hint.className = 'type-hint';
      hint.textContent = labelHint;
      label.appendChild(document.createTextNode(' '));
      label.appendChild(hint);
    }
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
    if (isResultChains) {
      const help = document.createElement('div');
      help.className = 'data-field-help';
      help.textContent = 'Filter which chains are included in the results. Choose one or more, or All.';
      group.appendChild(help);
    }
    fields[v.name] = { input, def: v };
    inputContainer.appendChild(group);
  }
  wrap.appendChild(inputContainer);

  if (q.notes && q.notes.length) {
    const notes = document.createElement('div');
    notes.className = 'data-query-notes';
    for (const text of q.notes) {
      const note = document.createElement('div');
      note.textContent = text;
      notes.appendChild(note);
    }
    wrap.appendChild(notes);
  }

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

  const copyActions = document.createElement('div');
  copyActions.className = 'data-query-copy-actions';
  copyActions.appendChild(dataCopyLink('[copy query]', 'Copy this GraphQL query', () => String(q.query || '').trim()));
  copyActions.appendChild(dataCopyLink('[copy build prompt]', 'Copy an LLM prompt to build this query', () => buildDataQueryPrompt(q)));
  actions.appendChild(copyActions);

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
        throw new Error(v.name + ' is required');
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
        td.appendChild(fmt(value, item, col));
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
      td.appendChild(fmt(value, obj, col));
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
          'query($projectId: Float!, $chainId: Float!) { project(version: 6, projectId: $projectId, chainId: $chainId) { suckerGroupId } }',
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
        if (node) resultPanel.appendChild(csvDownloadButton(q, () => [node]));
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
        const existingCsv = resultPanel.querySelector('.data-csv-btn');
        if (existingCsv) existingCsv.remove();
        if (state.items.length) resultPanel.appendChild(csvDownloadButton(q, () => state.items));
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
// `.getValue()` returns selected IDs, or every active-network ID when All is selected.
function renderChainMultiPills(varDef) {
  const wrapper = document.createElement('div');
  wrapper.className = 'fn-chain-selector data-chain-selector data-chain-multi';
  wrapper.dataset.selection = 'multiple';

  const chainEntries = bendystrawChains();
  const allNetworkChainIds = chainEntries.map(entry => Number(entry.id));
  const selected = new Set();

  function render() {
    wrapper.innerHTML = '';

    const pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';
    pillsRow.setAttribute('role', 'group');
    pillsRow.setAttribute('aria-label', 'Result chains, select one or more');
    for (const { id: cid, chain: ch } of chainEntries) {
      const idNum = Number(cid);
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (selected.has(idNum) ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.setAttribute('aria-pressed', selected.has(idNum) ? 'true' : 'false');
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
    allBtn.textContent = 'All';
    allBtn.title = 'search all chains in the active network';
    allBtn.setAttribute('aria-pressed', selected.size === 0 ? 'true' : 'false');
    allBtn.addEventListener('click', () => { selected.clear(); render(); });
    pillsRow.appendChild(allBtn);

    wrapper.appendChild(pillsRow);
  }

  render();
  wrapper.getValue = () => (selected.size ? Array.from(selected) : allNetworkChainIds).join(',');
  Object.defineProperty(wrapper, 'value', { get() { return (selected.size ? Array.from(selected) : allNetworkChainIds).join(','); } });
  return wrapper;
}

// Paired (projectId + chainId) widget. The chain choice stays visible and uses
// the same pills as every other DATA-tab chain control. It is a single-select
// project scope; a separate chainIds control, when present, filters results.
// Side effect: registers `projectId` and `chainId` entries in `fields` so the
// outer collectVars() can read them.
function renderProjectAndChainPair(projectVar, chainVar, fields) {
  const section = document.createElement('div');
  section.className = 'input-group project-chain-pair project-chain-section';

  const idLabel = document.createElement('label');
  idLabel.className = 'input-label';
  idLabel.textContent = 'Project ID';
  section.appendChild(idLabel);

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.className = 'field numeric-field';
  idInput.placeholder = projectVar.default != null ? String(projectVar.default) : '';
  if (projectVar.default != null) idInput.value = String(projectVar.default);
  section.appendChild(idInput);

  const chainLabel = document.createElement('label');
  chainLabel.className = 'input-label data-project-chain-label';
  chainLabel.textContent = 'Project chain';
  const chainHint = document.createElement('span');
  chainHint.className = 'type-hint';
  chainHint.textContent = 'select one';
  chainLabel.appendChild(document.createTextNode(' '));
  chainLabel.appendChild(chainHint);
  section.appendChild(chainLabel);

  const chainInput = renderChainPills(chainVar);
  chainInput.classList.add('project-chain-picker');
  section.appendChild(chainInput);

  const help = document.createElement('div');
  help.className = 'data-field-help';
  help.textContent = 'Project ID and project chain together identify the deployment to query.';
  section.appendChild(help);

  fields[projectVar.name] = { input: idInput, def: projectVar };
  fields[chainVar.name] = { input: chainInput, def: chainVar };

  return section;
}

// Replicates form.js renderFormChainSelector but as an embeddable input.
// Returns an element with `.getValue()` returning the selected chainId as a string.
function renderChainPills(varDef) {
  const wrapper = document.createElement('div');
  wrapper.className = 'fn-chain-selector data-chain-selector';
  wrapper.dataset.selection = 'single';

  const chains = getManifestChains();
  const chainEntries = bendystrawChains();
  const defaultVal = varDef.default != null ? Number(varDef.default) : null;
  let selectedChain = defaultVal != null && inActiveNetwork(chains[String(defaultVal)])
    ? defaultVal
    : (varDef.optional ? null : defaultBendystrawChainId());

  function render() {
    wrapper.innerHTML = '';

    const pillsRow = document.createElement('div');
    pillsRow.className = 'chain-pills-row';
    pillsRow.setAttribute('role', 'group');
    pillsRow.setAttribute('aria-label', 'Project chain, select one');
    for (const { id: cid, chain: ch } of chainEntries) {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'chain-pill' + (ch.testnet ? ' testnet' : '') + (Number(cid) === selectedChain ? ' selected' : '');
      pill.textContent = ch.name;
      pill.dataset.chainId = cid;
      pill.setAttribute('aria-pressed', Number(cid) === selectedChain ? 'true' : 'false');
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
      clearBtn.setAttribute('aria-pressed', selectedChain == null ? 'true' : 'false');
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

function dataCopyLink(label, title, buildText) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'comp-prompt-link data-query-copy-link';
  button.textContent = label;
  button.title = title;
  button.addEventListener('click', function (event) {
    event.preventDefault();
    event.stopPropagation();
    copyPlainText(buildText()).then(function () {
      button.classList.add('comp-prompt-link--ok');
      button.textContent = '[copied]';
      setTimeout(function () {
        button.classList.remove('comp-prompt-link--ok');
        button.textContent = label;
      }, 1400);
    }).catch(function () {
      button.textContent = '[copy failed]';
      setTimeout(function () { button.textContent = label; }, 1800);
    });
  });
  return button;
}

export function buildDataQueryPrompt(query) {
  const q = query || {};
  const variableNames = new Set((q.variables || []).map(function (variable) { return variable.name; }));
  const variables = (q.variables || []).map(function (variable) {
    return {
      name: variable.name,
      type: variable.type,
      optional: !!variable.optional,
      hidden: !!variable.hidden,
      default: variable.default != null ? String(variable.default) : null,
    };
  });
  const columns = (q.columns || []).map(function (column) {
    return { key: column.key, label: column.label, format: column.format || 'text' };
  });
  const lines = [
    'Build a client-only, read-only Juicebox V6 data view for “' + (q.title || q.id || 'Bendystraw query') + '”.',
  ];
  if (q.hint) lines.push('Purpose: ' + q.hint);
  if (q.notes && q.notes.length) {
    lines.push('', 'Indexed-data semantics:');
    for (const note of q.notes) lines.push('- ' + note);
  }
  lines.push('', 'Use the Bendystraw GraphQL API. Follow the selected network: https://bendystraw.up.railway.app on mainnet and https://testnet.bendystraw.xyz on testnet. Read the endpoint/key handling from the reference implementation rather than hardcoding credentials.');
  if (q.resolveSuckerGroup) {
    lines.push('', 'This query is sucker-group scoped. First resolve projectId + its single Project chain to project(version: 6, projectId, chainId) { suckerGroupId }, then pass that suckerGroupId into the query below. A separate multi-select Result chains control filters chainIds; it must not change which chain scopes projectId.');
  }
  lines.push('', 'GraphQL query:', '```graphql', String(q.query || '').trim(), '```');
  lines.push('', 'Variables:', '```json', JSON.stringify(variables, null, 2), '```');
  lines.push('', 'Response path: ' + (q.path || '(use the query root field)'));
  lines.push('Table columns:', '```json', JSON.stringify(columns, null, 2), '```');
  const requirements = [
    '- Preserve bigint values exactly; do not coerce token counts or IDs through unsafe JavaScript numbers.',
    '- Include loading, empty, GraphQL error, and HTTP error states.',
    '- Support limit/offset pagination when those variables exist.',
    '- Render addresses, timestamps, chain names, transaction hashes, and amounts according to each column format.',
    '- Treat the GraphQL document, response path, variable contract, column formats, and indexed-data semantics above as one versioned interface. Do not rename fields, invent fallback fields, or silently reinterpret nullable legacy rows.',
    '- POST JSON with explicit GraphQL and JSON Accept/Content-Type headers; enforce a timeout and response-size bound; retry only bounded transient HTTP/network failures; surface GraphQL errors even when HTTP is 200.',
    '- Ignore or cancel stale responses after the network, project chain, project ID, filters, page, or query changes. Reset pagination when scope changes and do not merge rows from different requests.',
    '- Render all indexed strings as untrusted text, validate addresses and numeric inputs before querying, and keep endpoint credentials out of user-entered variables and logs.',
  ];
  if (variableNames.has('projectId') && variableNames.has('chainId')) {
    requirements.push('- Keep Project ID beside a visible, single-select Project chain control.');
  }
  if (variableNames.has('chainIds')) {
    requirements.push('- Label chainIds as Result chains and render it as a multi-select control with an All option.');
  }
  lines.push('', 'Requirements:');
  lines.push.apply(lines, requirements);
  lines.push('',
    'Reference implementation: https://github.com/mejango/juicescan — read src/data-tab.js, src/bendystraw-client.js, src/bendystraw-format.js, and data/bendystraw-queries.json.',
    'Juice SDK: https://github.com/Bananapus/juice-sdk-v4 — package `@bananapus/nana-sdk-core`. Inspect `packages/core/src/utils/bendystraw.ts`: `normalizeBendystrawEndpoint`, `selectBendystrawEndpoint`, `bendystrawDataHasFields`, and cache/filter helpers.',
    'Bendystraw schema: https://bendystraw-dev.up.railway.app/schema',
    '',
    'Verification required:',
    '- Add request-shape tests for the exact query and variables above, response-path/column-format tests with bigint-sized fixtures, and UI tests for loading, empty, pagination, stale responses, HTTP errors, GraphQL errors, timeout, malformed JSON, and nullable legacy rows.',
    '- Validate the document against the current Bendystraw schema and exercise it on the selected network. If the live schema differs from this copied query, report the mismatch instead of guessing a replacement.',
    '- Finish with the exact files changed, tests run, and any intentionally unsupported field or state.',
    '',
    'Live behavior to match: ' + (typeof location !== 'undefined' ? location.href : '(open this Juicescan data query in a browser)'));
  return lines.join('\n');
}

export function coerce(value, type) {
  switch (type) {
    case 'int':
    case 'chain': {
      const raw = String(value).trim();
      if (!/^-?\d+$/.test(raw)) throw new Error('Expected a whole number');
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed)) throw new Error('Number is outside JavaScript’s safe integer range');
      return parsed;
    }
    case 'chain_multi':
      // value is a comma-separated list of chain IDs from renderChainMultiPills.
      return String(value).split(',').filter(Boolean).map(function (part) {
        const raw = part.trim();
        if (!/^\d+$/.test(raw)) throw new Error('Expected comma-separated chain IDs');
        const parsed = Number(raw);
        if (!Number.isSafeInteger(parsed)) throw new Error('Chain ID is outside JavaScript’s safe integer range');
        return parsed;
      });
    case 'bigint':
      if (!/^-?\d+$/.test(String(value).trim())) throw new Error('Expected an integer');
      return String(value).trim();
    case 'address':
      if (!isAddress(value, { strict: false })) throw new Error('Expected a valid 0x address');
      return value.toLowerCase();
    case 'string':
    default:
      return value;
  }
}
