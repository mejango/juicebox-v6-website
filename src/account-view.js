// src/account-view.js
// Account view (#account/<address-or-ens>[/tab]): everything Juicebox knows about one account,
// laid out with the project page's tab idiom. Tabs: Activity (indexed V6 activity, plus any
// in-flight Relayr work when viewing your own account), Holdings (per-project token balances
// and owned store items), Projects (owned directly or through a Safe it signs for), and Roles
// (projects operated via granted permissions). "View as" is inherent: any address or ENS name
// in the hash renders that account; action CTAs only appear for the connected account.

import { el, truncAddr, getAccount, isAddr, getViewAs, setViewAs, clearViewAs } from './component-base.js';
import { formatTokenCount } from './pay-preview.js';
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

// Account-scoped activity: actions sent by the account plus beneficiary-only
// receipts. Every root is offset-paged so recipient history is not capped at
// the first page.
var ACCOUNT_ACTIVITY_QUERY = 'query($from: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'activityEvents(where: { from: $from, version: $version, ' + BENDYSTRAW_ACTIVITY_OR + ' }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'totalCount ' + BENDYSTRAW_ACTIVITY_ITEM_FIELDS + ' } '
  + 'beneficiaryPayEvents: payEvents(where: { beneficiary: $from, from_not: $from, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { totalCount items { '
  + 'id chainId projectId timestamp txHash from beneficiary amount amountUsd memo newlyIssuedTokenCount } } '
  + 'beneficiaryCashOutEvents: cashOutTokensEvents(where: { beneficiary: $from, from_not: $from, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { totalCount items { '
  + 'id chainId projectId timestamp txHash from holder beneficiary cashOutCount reclaimAmount reclaimAmountUsd } } '
  + 'beneficiaryMintEvents: mintTokensEvents(where: { beneficiary: $from, from_not: $from, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { totalCount items { '
  + 'id chainId projectId timestamp txHash from beneficiary beneficiaryTokenCount } } '
  + 'beneficiaryManualMintEvents: manualMintTokensEvents(where: { beneficiary: $from, from_not: $from, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { totalCount items { '
  + 'id chainId projectId timestamp txHash from beneficiary beneficiaryTokenCount } } '
  + 'beneficiaryAutoIssueEvents: autoIssueEvents(where: { beneficiary: $from, from_not: $from, version: $version }, '
  + 'orderBy: "timestamp", orderDirection: "desc", limit: $limit, offset: $offset) { totalCount items { '
  + 'id chainId projectId timestamp txHash from beneficiary count stageId } } }';
var ACCOUNT_ACTIVITY_ROOTS = [
  'activityEvents',
  'beneficiaryPayEvents',
  'beneficiaryCashOutEvents',
  'beneficiaryMintEvents',
  'beneficiaryManualMintEvents',
  'beneficiaryAutoIssueEvents',
];

function accountActivityRows(data) {
  var rows = ((data && data.activityEvents && data.activityEvents.items) || []).slice();
  function add(root, field, map) {
    var items = (data && data[root] && data[root].items) || [];
    items.forEach(function (item) {
      var event = {
        id: root + ':' + item.id,
        chainId: item.chainId,
        projectId: item.projectId,
        timestamp: item.timestamp,
        txHash: item.txHash,
        from: item.from,
      };
      event[field] = map ? map(item) : item;
      rows.push(event);
    });
  }
  add('beneficiaryPayEvents', 'payEvent');
  add('beneficiaryCashOutEvents', 'cashOutTokensEvent');
  add('beneficiaryMintEvents', '_accountReceipt', function (item) {
    return { beneficiary: item.beneficiary, tokenCount: item.beneficiaryTokenCount, from: item.from, txHash: item.txHash };
  });
  add('beneficiaryManualMintEvents', '_accountReceipt', function (item) {
    return { beneficiary: item.beneficiary, tokenCount: item.beneficiaryTokenCount, from: item.from, txHash: item.txHash };
  });
  add('beneficiaryAutoIssueEvents', 'autoIssueEvent');
  rows.sort(function (a, b) { return Number(b.timestamp) - Number(a.timestamp); });
  return rows;
}

async function fetchAccountActivityWindow(address) {
  var merged = {};
  ACCOUNT_ACTIVITY_ROOTS.forEach(function (root) {
    merged[root] = { items: [], totalCount: 0 };
  });
  var offset = 0;
  while (true) {
    var limit = 250;
    var data = await bendystrawQuery(ACCOUNT_ACTIVITY_QUERY, {
      from: address.toLowerCase(), version: VERSION, limit: limit, offset: offset,
    });
    ACCOUNT_ACTIVITY_ROOTS.forEach(function (root) {
      var source = data && data[root];
      var nextTotal = source && source.totalCount != null
        ? Number(source.totalCount)
        : merged[root].items.length + ((source && source.items && source.items.length) || 0);
      if (offset > 0 && nextTotal !== merged[root].totalCount) {
        throw new Error('Account activity changed while loading');
      }
      if ((!source || !source.items || !source.items.length) && offset < nextTotal) {
        throw new Error('Account activity ended before its reported total');
      }
      merged[root].items = merged[root].items.concat((source && source.items) || []);
      merged[root].totalCount = nextTotal;
    });
    offset += limit;
    if (ACCOUNT_ACTIVITY_ROOTS.every(function (root) {
      return merged[root].items.length >= merged[root].totalCount;
    })) break;
  }
  var items = accountActivityRows(merged);
  return { items: items, totalCount: items.length };
}
// Minimal per-project stub data the activity interpreter reads: display name plus the deployed
// ERC-20's symbol/address (bendystraw's project.tokenSymbol is the ACCOUNTING token, not the
// project's ERC-20 — the nested deploy event carries the real one).
var ACCOUNT_PROJECT_STUBS_QUERY = 'query($chainId: Int!, $version: Int!, $projectIds: [Int!], $limit: Int!, $offset: Int!) { '
  + 'projects(where: { chainId: $chainId, version: $version, projectId_in: $projectIds }, limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId name handle deployErc20Events(limit: 1) { items { symbol token } } } } }';
var ACCOUNT_OWNED_QUERY = 'query($owner: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'projects(where: { owner: $owner, version: $version }, limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId name handle } } }';
var ACCOUNT_SAFE_OWNED_QUERY = 'query($owners: [String!], $chainId: Int!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'projects(where: { owner_in: $owners, chainId: $chainId, version: $version }, limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId name handle owner } } }';
var ACCOUNT_OPERATED_QUERY = 'query($operator: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'permissionHolders(where: { operator: $operator, version: $version }, limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId account operator permissions isRevnetOperator } } }';
// Holdings: per-project token balances. Version-pinned like every other account query — this whole
// site is V6-only, so V4/V5 participant rows must never appear. creditBalance/erc20Balance carry the
// unclaimed-credits vs claimed-ERC-20 split; totalCount makes single-page truncation honest.
export var ACCOUNT_TOKEN_HOLDINGS_QUERY = 'query($account: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'participants(where: { address: $account, version: $version, balance_gt: "0" }, '
  + 'orderBy: "balance", orderDirection: "desc", limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId version balance creditBalance erc20Balance } } }';
// Holdings: store items (721s) currently owned, version-pinned for the same reason. `hook` is part of
// bendystraw's nft primary key (chainId, hook, tokenId, version) — JB721 tokenIds (tierId*1e9+serial)
// collide across every collection on a chain, so identity must include the collection.
export var ACCOUNT_NFT_HOLDINGS_QUERY = 'query($owner: String!, $version: Int!, $limit: Int!, $offset: Int!) { '
  + 'nfts(where: { owner: $owner, version: $version }, limit: $limit, offset: $offset) { '
  + 'totalCount items { chainId projectId hook tokenId tierId } } }';

async function fetchAllOffsetPages(query, path, variables, pageSize) {
  var items = [], totalCount = 0;
  while (items.length < totalCount || items.length === 0) {
    var data = await bendystrawQuery(query, Object.assign({}, variables, {
      limit: pageSize || 250,
      offset: items.length,
    }));
    var result = data && data[path];
    var page = (result && result.items) || [];
    totalCount = result && result.totalCount != null ? Number(result.totalCount) : items.length + page.length;
    items = items.concat(page);
    if (!page.length || items.length >= totalCount) break;
  }
  return items;
}

// -- Pure helpers (unit-tested) --

// The account page's tabs, in display order. Slugs double as the hash segment; the first is default.
export var ACCOUNT_TABS = ['activity', 'holdings', 'projects', 'roles'];

// '#account/<rest>' payload → { address, tab } (checksummed/hex) or { ens, tab } or null for
// garbage. The optional second segment picks a tab; unknown tabs fall back to the default.
export function parseAccountRoute(rest) {
  var v = String(rest == null ? '' : rest);
  try { v = decodeURIComponent(v); } catch (_) {}
  var parts = v.split('/');
  var who = (parts[0] || '').trim();
  if (!who) return null;
  var tab = (parts[1] || '').trim().toLowerCase();
  if (ACCOUNT_TABS.indexOf(tab) === -1) tab = ACCOUNT_TABS[0];
  if (isAddr(who)) return { address: who, tab: tab };
  if (isEnsName(who)) return { ens: who.toLowerCase(), tab: tab };
  return null;
}

// participants rows arrive balance-desc, version-pinned to 6 (one row per project by the indexer's
// primary key); keep one row per (chainId, projectId) defensively, preserving first-seen order.
export function dedupeTokenHoldings(items) {
  var byKey = {}, order = [];
  (items || []).forEach(function (it) {
    if (!it) return;
    var chainId = Number(it.chainId), projectId = Number(it.projectId);
    if (!Number.isFinite(chainId) || !Number.isFinite(projectId) || projectId <= 0) return;
    var key = chainId + ':' + projectId;
    if (!byKey[key]) { byKey[key] = it; order.push(key); }
  });
  return order.map(function (key) { return byKey[key]; });
}

// The credit/ERC-20 composition of a participant row's combined balance, or null when it's all
// claimed ERC-20 (the default assumption) or the split fields are absent/garbage.
export function holdingSplitLabel(row) {
  if (!row) return null;
  var credit, erc20;
  try {
    credit = BigInt(row.creditBalance == null ? 0 : row.creditBalance);
    erc20 = BigInt(row.erc20Balance == null ? 0 : row.erc20Balance);
  } catch (_) { return null; }
  if (credit > 0n && erc20 > 0n) return formatTokenCount(erc20) + ' ERC-20 + ' + formatTokenCount(credit) + ' credits';
  if (credit > 0n) return 'credits (unclaimed)';
  return null;
}

// "Showing the first N of M <noun>." when the indexer holds more rows than the single page the view
// fetches; null when everything fit (or totalCount was unavailable).
export function capNote(shownCount, totalCount, noun) {
  var total = Number(totalCount);
  if (!Number.isFinite(total) || total <= shownCount) return null;
  return 'Showing the first ' + shownCount + ' of ' + total + ' ' + noun + '.';
}

// nft rows → dedupe by (chainId, hook, tokenId) — the collection-scoped identity; bare tokenIds
// collide across collections on a chain — then group by (chainId, projectId) with per-tier
// quantities: { chainId, projectId, tiers: [{tierId, count}] }.
export function groupNftHoldings(items) {
  var seenToken = {}, byProj = {}, order = [];
  (items || []).forEach(function (it) {
    if (!it) return;
    var chainId = Number(it.chainId), projectId = Number(it.projectId), tierId = Number(it.tierId);
    if (!Number.isFinite(chainId) || !Number.isFinite(projectId) || projectId <= 0) return;
    var tokenKey = chainId + ':' + String(it.hook == null ? '' : it.hook).toLowerCase() + ':' + String(it.tokenId);
    if (seenToken[tokenKey]) return;
    seenToken[tokenKey] = true;
    var projKey = chainId + ':' + projectId;
    var g = byProj[projKey];
    if (!g) { g = byProj[projKey] = { chainId: chainId, projectId: projectId, tiers: [] }; order.push(g); }
    var tier = null;
    for (var i = 0; i < g.tiers.length; i++) if (g.tiers[i].tierId === tierId) { tier = g.tiers[i]; break; }
    if (!tier) { tier = { tierId: tierId, count: 0 }; g.tiers.push(tier); }
    tier.count += 1;
  });
  order.forEach(function (g) { g.tiers.sort(function (a, b) { return a.tierId - b.tierId; }); });
  return order;
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

// "Chain | #id" chip shown next to a project link across all account cards.
function chainChipNode(chainId, projectId) {
  var chain = el('span', 'account-proj-chain');
  chain.textContent = chainNameOf(chainId) + ' | #' + Number(projectId);
  return chain;
}

// Set the location hash without retriggering the router (app.js's hashchange handler honors the flag).
function setHashQuiet(h) {
  if (location.hash === h) return;
  window.__suppressHash = true;
  location.hash = h;
}

// Best-effort project stubs for a list of {chainId, projectId} refs, keyed 'chainId:projectId'.
// One bendystraw query per chain; failures degrade to an empty map (rows render name-less).
function fetchProjectStubs(refs) {
  var byChain = {};
  (refs || []).forEach(function (r) { (byChain[r.chainId] = byChain[r.chainId] || []).push(r.projectId); });
  return Promise.all(Object.keys(byChain).map(function (cid) {
    return fetchAllOffsetPages(ACCOUNT_PROJECT_STUBS_QUERY, 'projects', {
      chainId: Number(cid), version: VERSION, projectIds: byChain[cid],
    }, 250).then(projectStubsFromRows).catch(function () { return {}; });
  })).then(function (maps) { return Object.assign.apply(Object, [{}].concat(maps)); });
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
  // #account routes have no nav-tab of their own (nothing in the header highlights), so give the view
  // the project-detail back affordance — the user always has a visible way home to the Discover grid.
  var back = el('button', 'detail-back account-back');
  back.type = 'button';
  back.textContent = '←';
  back.title = 'Back to projects';
  back.addEventListener('click', function () { location.hash = ''; });
  container.appendChild(back);
  var body = el('div');
  container.appendChild(body);
  var token = {};
  container._accountToken = token;
  function live() { return container._accountToken === token; }

  var parsed = parseAccountRoute(rest);
  if (!parsed) { body.appendChild(invalidCard(String(rest || '').trim())); return; }
  if (parsed.ens) {
    var note = el('div', 'detail-card-body');
    note.textContent = 'Resolving ' + parsed.ens + '…';
    body.appendChild(note);
    ensAddressOf(parsed.ens).then(function (addr) {
      if (!live()) return;
      body.innerHTML = '';
      if (!addr) { body.appendChild(invalidCard(parsed.ens)); return; }
      renderAccount(body, addr, parsed.ens, parsed.tab, live);
    });
    return;
  }
  renderAccount(body, parsed.address, parsed.address, parsed.tab, live);
}

// ident is the identity as routed (ENS name or address) so tab clicks keep the hash the user chose.
function renderAccount(container, address, ident, initialTab, live) {
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

  // Tab bar with the project page's visual idiom, hash-routed as #account/<ident>/<tab>.
  // Panes build lazily on first visit and are kept, so switching back doesn't re-fetch.
  var builders = {
    activity: function () { return renderActivityCard(address, isOwn, live); },
    holdings: function () { return renderHoldingsCard(address, live); },
    projects: function () { return renderOwnedCard(address, live); },
    roles: function () { return renderOperatedCard(address, live); },
  };
  var tabRow = el('div', 'project-detail-tabs');
  var contentArea = el('div', 'project-detail-content');
  var built = {};
  function showTab(slug) {
    if (!builders[slug]) slug = ACCOUNT_TABS[0];
    if (!built[slug]) built[slug] = builders[slug]();
    contentArea.innerHTML = '';
    contentArea.appendChild(built[slug]);
    var btns = tabRow.querySelectorAll('.detail-tab-btn');
    for (var b = 0; b < btns.length; b++) btns[b].classList.toggle('active', btns[b].dataset.tab === slug);
  }
  ACCOUNT_TABS.forEach(function (slug) {
    var btn = document.createElement('button');
    btn.className = 'detail-tab-btn';
    btn.dataset.tab = slug;
    btn.textContent = slug.charAt(0).toUpperCase() + slug.slice(1);
    btn.addEventListener('click', function () {
      showTab(slug);
      setHashQuiet('#account/' + ident + '/' + slug);
    });
    tabRow.appendChild(btn);
  });
  container.appendChild(tabRow);
  container.appendChild(contentArea);
  showTab(initialTab || ACCOUNT_TABS[0]);
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
  var loadedCount = 0;
  var totalCount = 0;
  var loadedAny = false;

  function stubFor(ev) {
    return stubs[Number(ev.chainId) + ':' + Number(ev.projectId)]
      || { chainId: Number(ev.chainId), projectId: Number(ev.projectId), chains: [] };
  }

  function loadStubs(events) {
    var refs = distinctProjectRefs(events).filter(function (r) { return !stubs[r.chainId + ':' + r.projectId]; });
    if (!refs.length) return Promise.resolve();
    // graceful: on fetch failure rows fall back to a symbol-less stub
    return fetchProjectStubs(refs).then(function (map) { Object.assign(stubs, map); });
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
    fetchAccountActivityWindow(address).then(function (page) {
      totalCount = page.totalCount;
      var items = page.items.slice(loadedCount, loadedCount + ACTIVITY_PAGE);
      return loadStubs(items).then(function () { return items; });
    }).then(function (items) {
      if (!live()) return;
      appendRows(items);
      loadedCount += items.length;
      status.style.display = 'none';
      if (!loadedAny) {
        status.style.display = '';
        status.textContent = 'No indexed V6 activity for this account yet.';
      }
      more.style.display = loadedCount < totalCount ? '' : 'none';
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

// -- Holdings (tokens + store items) --

function renderHoldingsCard(address, live) {
  var wrap = el('div', 'account-holdings');
  wrap.appendChild(renderTokenHoldingsCard(address, live));
  wrap.appendChild(renderNftHoldingsCard(address, live));
  return wrap;
}

function renderTokenHoldingsCard(address, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Tokens'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = 'Loading…';
  card.appendChild(body);

  fetchAllOffsetPages(ACCOUNT_TOKEN_HOLDINGS_QUERY, 'participants', {
    account: address.toLowerCase(), version: VERSION,
  }, 250).then(function (items) {
    var rows = dedupeTokenHoldings(items);
    return fetchProjectStubs(rows).then(function (stubMap) {
      if (!live() || !body.isConnected) return;
      body.innerHTML = '';
      if (!rows.length) { body.textContent = 'No project token balances for this account.'; return; }
      rows.forEach(function (row) {
        var stub = stubMap[row.chainId + ':' + row.projectId];
        var line = el('div', 'account-proj-row');
        line.appendChild(projectLinkNode('account-proj-link', row.chainId, row.projectId, stub && stub.name));
        line.appendChild(chainChipNode(row.chainId, row.projectId));
        var bal = el('span', 'account-holding-balance');
        // Project tokens are always 18-decimal (this is the credit/ERC-20 balance, never the
        // accounting token); symbol comes from the deployed ERC-20, else the "tokens" fallback.
        bal.textContent = formatTokenCount(row.balance) + ' ' + ((stub && stub.tokenSymbol) || 'tokens');
        line.appendChild(bal);
        // Unclaimed credits vs claimed ERC-20 — moving between chains needs the ERC-20 side.
        var split = holdingSplitLabel(row);
        if (split) {
          var splitEl = el('span', 'account-holding-split');
          splitEl.textContent = split;
          line.appendChild(splitEl);
        }
        body.appendChild(line);
      });
    });
  }).catch(function () {
    if (!live() || !body.isConnected) return;
    body.textContent = 'Could not load token balances from Bendystraw.';
  });
  return card;
}

function renderNftHoldingsCard(address, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Store items'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = 'Loading…';
  card.appendChild(body);

  fetchAllOffsetPages(ACCOUNT_NFT_HOLDINGS_QUERY, 'nfts', {
    owner: address.toLowerCase(), version: VERSION,
  }, 250).then(function (items) {
    var groups = groupNftHoldings(items);
    return fetchProjectStubs(groups).then(function (stubMap) {
      if (!live() || !body.isConnected) return;
      body.innerHTML = '';
      if (!groups.length) { body.textContent = 'No store items held by this account.'; return; }
      groups.forEach(function (g) {
        var stub = stubMap[g.chainId + ':' + g.projectId];
        var line = el('div', 'account-proj-row');
        line.appendChild(projectLinkNode('account-proj-link', g.chainId, g.projectId, stub && stub.name));
        line.appendChild(chainChipNode(g.chainId, g.projectId));
        g.tiers.forEach(function (t) {
          var item = el('span', 'account-holding-item');
          item.textContent = 'Tier ' + t.tierId + (t.count > 1 ? ' × ' + t.count : '');
          line.appendChild(item);
        });
        body.appendChild(line);
      });
    });
  }).catch(function () {
    if (!live() || !body.isConnected) return;
    body.textContent = 'Could not load store items from Bendystraw.';
  });
  return card;
}

// -- Owned projects --

function renderOwnedCard(address, live) {
  var card = el('div', 'detail-card');
  var title = el('div', 'detail-card-title'); title.textContent = 'Owned projects'; card.appendChild(title);
  var body = el('div', 'detail-card-body');
  body.textContent = 'Loading…';
  card.appendChild(body);

  var owner = address.toLowerCase();
  var safeOwnershipPartial = false;
  var direct = fetchAllOffsetPages(
    ACCOUNT_OWNED_QUERY,
    'projects',
    { owner: owner, version: VERSION },
    250
  );

  // Safe-owned: for each active chain with a Safe Transaction Service, list the Safes this account
  // signs for, then find projects owned by any of them (project ownership is chain-local).
  var viaSafe = Promise.all(activeDiscoverChains().filter(function (c) { return hasSafeService(c.id); }).map(function (c) {
    return safesForOwner(address, c.id).catch(function () {
      safeOwnershipPartial = true;
      return [];
    }).then(function (safes) {
      if (!safes.length) return [];
      return fetchAllOffsetPages(ACCOUNT_SAFE_OWNED_QUERY, 'projects', {
        owners: safes.map(function (s) { return String(s).toLowerCase(); }), chainId: c.id, version: VERSION,
      }, 250).then(function (items) {
        return items.map(function (row) {
          return Object.assign({ safe: row.owner }, row);
        });
      }).catch(function () {
        safeOwnershipPartial = true;
        return [];
      });
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
      line.appendChild(chainChipNode(row.chainId, row.projectId));
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
    if (safeOwnershipPartial) {
      var warning = el('div', 'account-holdings-cap');
      warning.textContent = 'Some Safe-owned projects could not be loaded.';
      body.appendChild(warning);
    }
  }).catch(function () {
    if (!live() || !body.isConnected) return;
    body.textContent = 'Could not load owned projects from Bendystraw or Safe services.';
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

  fetchAllOffsetPages(ACCOUNT_OPERATED_QUERY, 'permissionHolders', {
    operator: address.toLowerCase(), version: VERSION,
  }, 250).then(function (items) {
    if (!live() || !body.isConnected) return;
    var groups = groupOperatedProjects(items);
    body.innerHTML = '';
    if (!groups.length) { body.textContent = 'This account operates no V6 projects.'; return; }

    // Best-effort project names for the group headers.
    fetchProjectStubs(groups).then(function (stubMap) {
      if (!body.isConnected) return;
      groups.forEach(function (g) {
        var stub = stubMap[g.chainId + ':' + g.projectId];
        var row = el('div', 'powers-row');
        var head = el('div', 'powers-head');
        var lab = el('span', 'powers-label');
        lab.appendChild(projectLinkNode('account-proj-link', g.chainId, g.projectId, stub && stub.name));
        head.appendChild(lab);
        head.appendChild(chainChipNode(g.chainId, g.projectId));
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
