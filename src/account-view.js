// src/account-view.js
// Account view (#account/<address-or-ens>): everything Juicebox knows about one account —
// its indexed V6 activity (with any in-flight Relayr work when viewing your own account),
// the projects it owns (directly or through a Safe it signs for), and the projects it
// operates via granted permissions. "View as" is inherent: any address or ENS name in the
// hash renders that account; action CTAs only appear for the connected account.

import { el, truncAddr, getAccount, isAddr, getViewAs, setViewAs, clearViewAs } from './component-base.js';
import { bendystrawQuery } from './bendystraw-client.js';
import {
  ensAddressOf, addressNode, identGradient, activityRowFromEvent, renderActivityRow,
  permissionLabel, permissionDesc, slugForChain, fetchSafeInfo, activeDiscoverChains,
  BENDYSTRAW_ACTIVITY_OR, BENDYSTRAW_ACTIVITY_ITEM_FIELDS,
} from './discover.js';
import { isEnsName } from './create-flow.js';
import { safesForOwner, hasSafeService } from './safe.js';
import { listRelayrPendingScopes, loadRelayrPendingSession, saveRelayrPendingSession, relayrPoll, relayrProgress } from './relayr.js';
import { renderRelayrReceiptInto } from './relayr-ui.js';

var VERSION = 6;
var ACTIVITY_PAGE = 25;

// Account-scoped activity: same event union + item fields as the project feed, filtered by the
// top-level `from` column, paged with Ponder's cursor (`after`).
var ACCOUNT_ACTIVITY_QUERY = 'query($from: String!, $version: Int!, $limit: Int!, $after: String) { '
  + 'activityEvents(where: { from: $from, version: $version, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, after: $after) { '
  + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' pageInfo { endCursor hasNextPage } } }';
// Minimal per-project stub data the activity interpreter reads: display name plus the deployed
// ERC-20's symbol/address (bendystraw's project.tokenSymbol is the ACCOUNTING token, not the
// project's ERC-20 — the nested deploy event carries the real one).
var ACCOUNT_PROJECT_STUBS_QUERY = 'query($chainId: Int!, $version: Int!, $projectIds: [Int!]) { '
  + 'projects(where: { chainId: $chainId, version: $version, projectId_in: $projectIds }, limit: 100) { '
  + 'items { chainId projectId name handle deployErc20Events(limit: 1) { items { symbol token } } } } }';
var ACCOUNT_OWNED_QUERY = 'query($owner: String!, $version: Int!) { '
  + 'projects(where: { owner: $owner, version: $version }, limit: 100) { '
  + 'items { chainId projectId name handle } } }';
var ACCOUNT_SAFE_OWNED_QUERY = 'query($owners: [String!], $chainId: Int!, $version: Int!) { '
  + 'projects(where: { owner_in: $owners, chainId: $chainId, version: $version }, limit: 100) { '
  + 'items { chainId projectId name handle owner } } }';
var ACCOUNT_OPERATED_QUERY = 'query($operator: String!, $version: Int!) { '
  + 'permissionHolders(where: { operator: $operator, version: $version }, limit: 200) { '
  + 'items { chainId projectId account operator permissions isRevnetOperator } } }';

// -- Pure helpers (unit-tested) --

// '#account/<rest>' payload → { address } (checksummed/hex) or { ens } or null for garbage.
export function parseAccountRoute(rest) {
  var v = String(rest == null ? '' : rest);
  try { v = decodeURIComponent(v); } catch (_) {}
  v = v.trim();
  if (!v) return null;
  if (isAddr(v)) return { address: v };
  if (isEnsName(v)) return { ens: v.toLowerCase() };
  return null;
}

// Distinct (chainId, projectId) pairs referenced by a page of activity events, in first-seen order.
export function distinctProjectRefs(events) {
  var seen = {}, refs = [];
  (events || []).forEach(function (ev) {
    var chainId = Number(ev && ev.chainId), projectId = Number(ev && ev.projectId);
    if (!Number.isFinite(chainId) || !Number.isFinite(projectId) || projectId <= 0) return;
    var key = chainId + ':' + projectId;
    if (seen[key]) return;
    seen[key] = true;
    refs.push({ chainId: chainId, projectId: projectId });
  });
  return refs;
}

// Bendystraw project rows → map of 'chainId:projectId' → minimal project stub for the activity
// interpreter (tokenSymbol/tokenAddress from the nested ERC-20 deploy; omitted when not deployed).
export function projectStubsFromRows(rows) {
  var map = {};
  (rows || []).forEach(function (row) {
    if (!row) return;
    var erc20 = row.deployErc20Events && row.deployErc20Events.items && row.deployErc20Events.items[0];
    map[Number(row.chainId) + ':' + Number(row.projectId)] = {
      chainId: Number(row.chainId),
      projectId: Number(row.projectId),
      name: row.name || row.handle || null,
      tokenSymbol: (erc20 && erc20.symbol) || null,
      tokenAddress: (erc20 && erc20.token) || null,
      chains: [],
    };
  });
  return map;
}

// Merge directly-owned and Safe-owned project rows, deduped by (chainId, projectId). Direct rows
// come first so a project owned by the address itself never shows a Safe badge.
export function dedupeOwnedProjects(direct, viaSafe) {
  var seen = {}, out = [];
  (direct || []).concat(viaSafe || []).forEach(function (row) {
    if (!row) return;
    var key = Number(row.chainId) + ':' + Number(row.projectId);
    if (seen[key]) return;
    seen[key] = true;
    out.push(row);
  });
  return out;
}

// permissionHolders rows → one group per (chainId, projectId) with each grant's numeric permission
// ids. Rows whose permission set was cleared (stale grants) are dropped, like the project view does.
export function groupOperatedProjects(items) {
  var byProj = {}, order = [];
  (items || []).forEach(function (it) {
    if (!it) return;
    var perms = (it.permissions || []).map(Number).filter(function (n) { return n > 0; });
    if (!perms.length) return;
    var key = Number(it.chainId) + ':' + Number(it.projectId);
    var g = byProj[key];
    if (!g) { g = byProj[key] = { chainId: Number(it.chainId), projectId: Number(it.projectId), grants: [] }; order.push(g); }
    g.grants.push({ account: it.account, isRevnetOperator: !!it.isRevnetOperator, permissions: perms });
  });
  order.forEach(function (g) {
    var union = {};
    g.grants.forEach(function (grant) { grant.permissions.forEach(function (n) { union[n] = true; }); });
    g.permsUnion = Object.keys(union).map(Number).sort(function (a, b) { return a - b; });
    g.isRevnetOperator = g.grants.some(function (grant) { return grant.isRevnetOperator; });
  });
  return order;
}

// -- View --

function projectHash(chainId, projectId) {
  return '#' + slugForChain(Number(chainId)) + ':' + Number(projectId);
}

function chainNameOf(chainId) {
  var chains = activeDiscoverChains();
  for (var i = 0; i < chains.length; i++) if (chains[i].id === Number(chainId)) return chains[i].name;
  return 'Chain ' + chainId;
}

function projectLinkNode(className, chainId, projectId, name) {
  var a = document.createElement('a');
  a.className = className;
  a.href = projectHash(chainId, projectId);
  a.textContent = name || ('Project #' + Number(projectId));
  return a;
}

function viewAsForm(prefill) {
  var wrap = el('div', 'account-viewas');
  var input = el('input', 'field');
  input.type = 'text';
  input.placeholder = '0x address or ENS name';
  if (prefill) input.value = prefill;
  var go = el('button', 'account-viewas-go');
  go.type = 'button';
  go.textContent = 'View';
  function submit() {
    var v = (input.value || '').trim();
    if (v) location.hash = '#account/' + v;
  }
  go.addEventListener('click', submit);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
  wrap.appendChild(input);
  wrap.appendChild(go);
  return wrap;
}

function invalidCard(query) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Account'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = query
    ? 'Could not resolve "' + query + '". Enter a 0x address or an ENS name.'
    : 'Enter a 0x address or an ENS name to view an account.';
  card.appendChild(body);
  card.appendChild(viewAsForm(''));
  return card;
}

export function renderAccountView(rest) {
  var container = document.getElementById('tab-account');
  if (!container) return;
  container.innerHTML = '';
  var token = {};
  container._accountToken = token;
  function live() { return container._accountToken === token; }

  var parsed = parseAccountRoute(rest);
  if (!parsed) { container.appendChild(invalidCard(String(rest || '').trim())); return; }
  if (parsed.ens) {
    var note = el('div', 'detail-card-body');
    note.textContent = 'Resolving ' + parsed.ens + '…';
    container.appendChild(note);
    ensAddressOf(parsed.ens).then(function (addr) {
      if (!live()) return;
      container.innerHTML = '';
      if (!addr) { container.appendChild(invalidCard(parsed.ens)); return; }
      renderAccount(container, addr, live);
    });
    return;
  }
  renderAccount(container, parsed.address, live);
}

function renderAccount(container, address, live) {
  var connected = getAccount();
  var isOwn = !!(connected && connected.toLowerCase() === address.toLowerCase());
  var homeChain = activeDiscoverChains()[0];

  var head = el('div', 'account-head');
  var avatar = el('span', 'account-avatar');
  avatar.style.background = identGradient(address.toLowerCase());
  head.appendChild(avatar);
  head.appendChild(addressNode(address, homeChain && homeChain.id));
  if (isOwn) { var you = el('span', 'account-you'); you.textContent = 'Connected'; head.appendChild(you); }
  // Site-wide "View as": browse the WHOLE site as this account (the input below only navigates
  // between account pages). The button flips to an exit while impersonating this address.
  var viewingThis = !!(getViewAs() && getViewAs().toLowerCase() === address.toLowerCase());
  if (!isOwn || viewingThis) {
    var siteAs = el('button', 'account-viewas-go account-siteas');
    siteAs.type = 'button';
    siteAs.textContent = viewingThis ? 'Exit View as' : 'View site as this account';
    siteAs.title = viewingThis
      ? 'Stop viewing the site as this account'
      : 'Browse the whole site as this account (read-only)';
    siteAs.addEventListener('click', function () {
      if (viewingThis) clearViewAs();
      else setViewAs(address);
    });
    head.appendChild(siteAs);
  }
  head.appendChild(viewAsForm(''));
  container.appendChild(head);

  container.appendChild(renderActivityCard(address, isOwn, live));
  container.appendChild(renderOwnedCard(address, live));
  container.appendChild(renderOperatedCard(address, live));
}

// -- Activity --

function renderActivityCard(address, isOwn, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Activity'; card.appendChild(title);

  if (isOwn) {
    var pending = renderPendingRelayrSection();
    if (pending) card.appendChild(pending);
  }

  var body = el('div', 'activity-feed');
  card.appendChild(body);
  var status = el('div', 'detail-card-body account-activity-status');
  status.textContent = 'Loading activity…';
  card.appendChild(status);
  var more = el('button', 'account-load-more');
  more.type = 'button';
  more.textContent = 'Load more';
  more.style.display = 'none';
  card.appendChild(more);

  var stubs = {};
  var cursor = null;
  var loadedAny = false;

  function stubFor(ev) {
    return stubs[Number(ev.chainId) + ':' + Number(ev.projectId)]
      || { chainId: Number(ev.chainId), projectId: Number(ev.projectId), chains: [] };
  }

  function loadStubs(events) {
    var refs = distinctProjectRefs(events).filter(function (r) { return !stubs[r.chainId + ':' + r.projectId]; });
    if (!refs.length) return Promise.resolve();
    var byChain = {};
    refs.forEach(function (r) { (byChain[r.chainId] = byChain[r.chainId] || []).push(r.projectId); });
    return Promise.all(Object.keys(byChain).map(function (cid) {
      return bendystrawQuery(ACCOUNT_PROJECT_STUBS_QUERY, {
        chainId: Number(cid), version: VERSION, projectIds: byChain[cid],
      }).then(function (data) {
        Object.assign(stubs, projectStubsFromRows(data && data.projects && data.projects.items));
      }).catch(function () {}); // graceful: rows fall back to a symbol-less stub
    }));
  }

  function appendRows(items) {
    items.forEach(function (ev) {
      var stub = stubFor(ev);
      var row = activityRowFromEvent(ev, stub);
      if (!row) return;
      var rowEl = renderActivityRow(row, stub);
      // Account context: each row also links to the project it happened on.
      if (Number(ev.projectId) > 0) {
        var main = rowEl.querySelector('.activity-main');
        if (main) main.appendChild(projectLinkNode('account-activity-proj', ev.chainId, ev.projectId, stub.name));
      }
      body.appendChild(rowEl);
      loadedAny = true;
    });
  }

  function loadPage() {
    more.disabled = true;
    status.style.display = '';
    status.textContent = 'Loading activity…';
    bendystrawQuery(ACCOUNT_ACTIVITY_QUERY, {
      from: address.toLowerCase(), version: VERSION, limit: ACTIVITY_PAGE, after: cursor,
    }).then(function (data) {
      var res = data && data.activityEvents;
      var items = (res && res.items) || [];
      cursor = (res && res.pageInfo && res.pageInfo.hasNextPage) ? res.pageInfo.endCursor : null;
      return loadStubs(items).then(function () { return items; });
    }).then(function (items) {
      if (!live()) return;
      appendRows(items);
      status.style.display = 'none';
      if (!loadedAny) {
        status.style.display = '';
        status.textContent = 'No indexed V6 activity for this account yet.';
      }
      more.style.display = cursor ? '' : 'none';
      more.disabled = false;
    }).catch(function () {
      if (!live()) return;
      status.style.display = '';
      status.textContent = loadedAny ? 'Could not load more activity.' : 'Could not load activity from Bendystraw.';
      more.disabled = false;
    });
  }

  more.addEventListener('click', loadPage);
  loadPage();
  return card;
}

// In-flight cross-chain work paid through Relayr, restored from this browser's saved receipts.
// Relayr is expected to ship a query-by-account API soon. When it does,
// replace this localStorage scan with a fetch against that endpoint so any
// viewer (and any device) sees the account's Relayr history/state.
function renderPendingRelayrSection() {
  var wrap = el('div', 'account-pending');
  listRelayrPendingScopes().forEach(function (scope) {
    var session = loadRelayrPendingSession(scope);
    if (!session) return;
    var panel = el('div', 'relayr-pending-panel');
    var note = 'Saved on this device' + (scope ? ' (' + scope + ')' : '') + '. Status is checked against Relayr by bundle ID — nothing is ever re-submitted.';
    function paint() {
      renderRelayrReceiptInto(panel, session, { noteText: note });
      var progress = relayrProgress(session.records, session.expectedCount);
      if (progress.pending > 0) {
        var btn = el('button', 'account-viewas-go account-pending-check');
        btn.type = 'button';
        btn.textContent = 'Check status';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = 'Checking…';
          // Retry = resume polling the already-paid bundle by its uuid.
          relayrPoll(session.bundleUuid, function (records) {
            session.records = records;
            saveRelayrPendingSession(scope, session);
          }, 2500, 15000).catch(function () {}).then(function () {
            if (panel.isConnected) paint();
          });
        });
        panel.appendChild(btn);
      }
    }
    paint();
    wrap.appendChild(panel);
  });
  if (!wrap.childNodes.length) return null;
  var label = el('div', 'account-pending-label');
  label.textContent = 'In-flight cross-chain requests';
  wrap.insertBefore(label, wrap.firstChild);
  return wrap;
}

// -- Owned projects --

function renderOwnedCard(address, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Owned projects'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = 'Loading…';
  card.appendChild(body);

  var owner = address.toLowerCase();
  var direct = bendystrawQuery(ACCOUNT_OWNED_QUERY, { owner: owner, version: VERSION })
    .then(function (data) { return (data && data.projects && data.projects.items) || []; })
    .catch(function () { return []; });

  // Safe-owned: for each active chain with a Safe Transaction Service, list the Safes this account
  // signs for, then find projects owned by any of them (project ownership is chain-local).
  var viaSafe = Promise.all(activeDiscoverChains().filter(function (c) { return hasSafeService(c.id); }).map(function (c) {
    return safesForOwner(address, c.id).catch(function () { return []; }).then(function (safes) {
      if (!safes.length) return [];
      return bendystrawQuery(ACCOUNT_SAFE_OWNED_QUERY, {
        owners: safes.map(function (s) { return String(s).toLowerCase(); }), chainId: c.id, version: VERSION,
      }).then(function (data) {
        return ((data && data.projects && data.projects.items) || []).map(function (row) {
          return Object.assign({ safe: row.owner }, row);
        });
      }).catch(function () { return []; });
    });
  })).then(function (pages) { return [].concat.apply([], pages); });

  Promise.all([direct, viaSafe]).then(function (results) {
    if (!live() || !body.isConnected) return;
    var rows = dedupeOwnedProjects(results[0], results[1]);
    body.innerHTML = '';
    if (!rows.length) { body.textContent = 'No V6 projects owned by this account.'; return; }
    rows.forEach(function (row) {
      var line = el('div', 'account-proj-row');
      line.appendChild(projectLinkNode('account-proj-link', row.chainId, row.projectId, row.name || row.handle));
      var chain = el('span', 'account-proj-chain');
      chain.textContent = chainNameOf(row.chainId) + ' | #' + Number(row.projectId);
      line.appendChild(chain);
      if (row.safe) {
        var badge = el('span', 'account-safe-badge');
        badge.textContent = 'via Safe ' + truncAddr(row.safe);
        badge.title = row.safe;
        fetchSafeInfo(row.safe, row.chainId).then(function (info) {
          if (info && badge.isConnected) badge.textContent = 'via Safe ' + truncAddr(row.safe) + ' (' + info.threshold + '/' + info.owners.length + ')';
        }).catch(function () {});
        line.appendChild(badge);
      }
      body.appendChild(line);
    });
  });
  return card;
}

// -- Operated projects --

function renderOperatedCard(address, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Operated projects'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = 'Loading…';
  card.appendChild(body);

  bendystrawQuery(ACCOUNT_OPERATED_QUERY, { operator: address.toLowerCase(), version: VERSION }).then(function (data) {
    if (!live() || !body.isConnected) return;
    var groups = groupOperatedProjects(data && data.permissionHolders && data.permissionHolders.items);
    body.innerHTML = '';
    if (!groups.length) { body.textContent = 'This account operates no V6 projects.'; return; }

    // Best-effort project names for the group headers.
    var byChain = {};
    groups.forEach(function (g) { (byChain[g.chainId] = byChain[g.chainId] || []).push(g.projectId); });
    var names = Promise.all(Object.keys(byChain).map(function (cid) {
      return bendystrawQuery(ACCOUNT_PROJECT_STUBS_QUERY, {
        chainId: Number(cid), version: VERSION, projectIds: byChain[cid],
      }).then(function (d) { return projectStubsFromRows(d && d.projects && d.projects.items); }).catch(function () { return {}; });
    })).then(function (maps) { return Object.assign.apply(Object, [{}].concat(maps)); });

    names.then(function (stubMap) {
      if (!body.isConnected) return;
      groups.forEach(function (g) {
        var stub = stubMap[g.chainId + ':' + g.projectId];
        var row = el('div', 'powers-row');
        var head = el('div', 'powers-head');
        var lab = el('span', 'powers-label');
        lab.appendChild(projectLinkNode('account-proj-link', g.chainId, g.projectId, stub && stub.name));
        head.appendChild(lab);
        var chain = el('span', 'account-proj-chain');
        chain.textContent = chainNameOf(g.chainId) + ' | #' + g.projectId;
        head.appendChild(chain);
        if (g.isRevnetOperator) { var b = el('span', 'powers-state on'); b.textContent = 'Revnet operator'; head.appendChild(b); }
        row.appendChild(head);

        var seen = {};
        g.grants.forEach(function (grant) {
          var key = (grant.account || '').toLowerCase();
          if (!key || seen[key]) return;
          seen[key] = true;
          var granted = el('div', 'account-granted-by');
          granted.appendChild(document.createTextNode('Granted by '));
          granted.appendChild(addressNode(grant.account, g.chainId));
          row.appendChild(granted);
        });

        var list = el('div', 'perm-list');
        g.permsUnion.forEach(function (id) {
          var it = el('div', 'perm-list-item');
          var nm = el('span', 'perm-list-name'); nm.textContent = permissionLabel(id); it.appendChild(nm);
          var ds = el('span', 'perm-list-desc'); ds.textContent = permissionDesc(id); it.appendChild(ds);
          list.appendChild(it);
        });
        row.appendChild(list);
        body.appendChild(row);
      });
    });
  }).catch(function () {
    if (!live() || !body.isConnected) return;
    body.textContent = 'Could not read permissions from Bendystraw.';
  });
  return card;
}
