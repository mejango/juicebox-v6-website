// Account view pure helpers: route parsing (address + tab), activity project-stub building,
// owned-project dedupe, operated-project grouping, holdings version-dedupe and nft grouping —
// plus the safe-owner listing and the Relayr pending-scope enumeration the view is built on.
// DOM rendering is exercised through the offline-safe error paths.
import { describe, it, expect, vi } from 'vitest';
import {
  parseAccountRoute, distinctProjectRefs, projectStubsFromRows, dedupeOwnedProjects,
  groupOperatedProjects, dedupeTokenHoldings, groupNftHoldings, renderAccountView, ACCOUNT_TABS,
  holdingSplitLabel, capNote, ACCOUNT_TOKEN_HOLDINGS_QUERY, ACCOUNT_NFT_HOLDINGS_QUERY,
} from '../src/account-view.js';
import { listRelayrPendingScopes, loadRelayrPendingSession } from '../src/relayr.js';
import { safesForOwner } from '../src/safe.js';

const ADDR = '0x823b92d6A4b2AED4b15675c7917c9f922ea8ADAd';

describe('parseAccountRoute', () => {
  it('accepts a 0x address (and URI-encoded input), defaulting to the activity tab', () => {
    expect(parseAccountRoute(ADDR)).toEqual({ address: ADDR, tab: 'activity' });
    expect(parseAccountRoute(encodeURIComponent(' ' + ADDR + ' '))).toEqual({ address: ADDR, tab: 'activity' });
  });
  it('accepts an ENS name, lowercased', () => {
    expect(parseAccountRoute('Jango.ETH')).toEqual({ ens: 'jango.eth', tab: 'activity' });
    expect(parseAccountRoute('team.banny.eth')).toEqual({ ens: 'team.banny.eth', tab: 'activity' });
  });
  it('parses the tab segment for every known tab (case-insensitively)', () => {
    for (const tab of ACCOUNT_TABS) {
      expect(parseAccountRoute(ADDR + '/' + tab)).toEqual({ address: ADDR, tab });
    }
    expect(parseAccountRoute(ADDR + '/Holdings')).toEqual({ address: ADDR, tab: 'holdings' });
    expect(parseAccountRoute('jango.eth/roles')).toEqual({ ens: 'jango.eth', tab: 'roles' });
  });
  it('falls back to the default tab for unknown segments', () => {
    expect(parseAccountRoute(ADDR + '/bogus')).toEqual({ address: ADDR, tab: 'activity' });
    expect(parseAccountRoute(ADDR + '/')).toEqual({ address: ADDR, tab: 'activity' });
  });
  it('rejects garbage', () => {
    expect(parseAccountRoute('')).toBeNull();
    expect(parseAccountRoute(null)).toBeNull();
    expect(parseAccountRoute('0x123')).toBeNull(); // short hex
    expect(parseAccountRoute('12345')).toBeNull();
    expect(parseAccountRoute('0xnothexnothexnothexnothexnothexnothexnothe')).toBeNull();
    expect(parseAccountRoute('/holdings')).toBeNull(); // tab without an identity
  });
});

describe('holdings queries — V6-only, capped surfaces', () => {
  it('both holdings queries pin version (juicescan is V6-only; V4/V5 rows must never appear)', () => {
    expect(ACCOUNT_TOKEN_HOLDINGS_QUERY).toContain('version: $version');
    expect(ACCOUNT_NFT_HOLDINGS_QUERY).toContain('version: $version');
  });
  it('both holdings queries select totalCount so truncation can be surfaced honestly', () => {
    expect(ACCOUNT_TOKEN_HOLDINGS_QUERY).toContain('totalCount');
    expect(ACCOUNT_NFT_HOLDINGS_QUERY).toContain('totalCount');
  });
  it('the nft query selects hook — the collection component of bendystraw\'s (chainId, hook, tokenId, version) key', () => {
    expect(ACCOUNT_NFT_HOLDINGS_QUERY).toContain('hook');
  });
  it('the token query selects the credit/ERC-20 split', () => {
    expect(ACCOUNT_TOKEN_HOLDINGS_QUERY).toContain('creditBalance');
    expect(ACCOUNT_TOKEN_HOLDINGS_QUERY).toContain('erc20Balance');
  });
});

describe('dedupeTokenHoldings', () => {
  it('keeps one row per (chainId, projectId) in first-seen order, carrying the split fields through', () => {
    const items = [
      { chainId: 1, projectId: 3, version: 6, balance: '900', creditBalance: '100', erc20Balance: '800' },
      { chainId: 1, projectId: 3, version: 6, balance: '900', creditBalance: '100', erc20Balance: '800' }, // duplicate row
      { chainId: 8453, projectId: 3, version: 6, balance: '500', creditBalance: '500', erc20Balance: '0' },
      { chainId: 1, projectId: 0, version: 6, balance: '1' }, // no project
      null,
    ];
    const rows = dedupeTokenHoldings(items);
    expect(rows).toEqual([
      { chainId: 1, projectId: 3, version: 6, balance: '900', creditBalance: '100', erc20Balance: '800' },
      { chainId: 8453, projectId: 3, version: 6, balance: '500', creditBalance: '500', erc20Balance: '0' },
    ]);
    expect(dedupeTokenHoldings(null)).toEqual([]);
  });
});

describe('groupNftHoldings', () => {
  it('keys tokens by (chainId, hook, tokenId): same-chain tokenId collisions across collections both count', () => {
    const HOOK_A = '0xAaaa000000000000000000000000000000000001';
    const HOOK_B = '0xBbbb000000000000000000000000000000000002';
    const items = [
      // Two different projects' collections on the SAME chain minting the SAME JB721 tokenId
      // (tierId*1e9+serial collides across every collection) — both must survive.
      { chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '3000000001', tierId: 3 },
      { chainId: 1, projectId: 7, hook: HOOK_B, tokenId: '3000000001', tierId: 3 },
      { chainId: 1, projectId: 3, hook: HOOK_A.toLowerCase(), tokenId: '3000000001', tierId: 3 }, // duplicate row (case-insensitive hook)
      { chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '3000000002', tierId: 3 },
      { chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '5000000001', tierId: 5 },
      { chainId: 8453, projectId: 3, hook: HOOK_A, tokenId: '3000000001', tierId: 3 }, // same tokenId, other chain
      { chainId: 1, projectId: 0, hook: HOOK_A, tokenId: '1', tierId: 1 }, // no project
      null,
    ];
    const groups = groupNftHoldings(items);
    expect(groups).toEqual([
      { chainId: 1, projectId: 3, tiers: [{ tierId: 3, count: 2 }, { tierId: 5, count: 1 }] },
      { chainId: 1, projectId: 7, tiers: [{ tierId: 3, count: 1 }] },
      { chainId: 8453, projectId: 3, tiers: [{ tierId: 3, count: 1 }] },
    ]);
    expect(groupNftHoldings(null)).toEqual([]);
  });
});

describe('holdingSplitLabel', () => {
  const E18 = 10n ** 18n;
  it('shows both sides when the balance mixes claimed ERC-20 and unclaimed credits', () => {
    const label = holdingSplitLabel({ creditBalance: String(100n * E18), erc20Balance: String(800n * E18) });
    expect(label).toContain('ERC-20');
    expect(label).toContain('credits');
    expect(label).toContain('800');
    expect(label).toContain('100');
  });
  it('marks an all-credits balance', () => {
    expect(holdingSplitLabel({ creditBalance: String(5n * E18), erc20Balance: '0' })).toBe('credits (unclaimed)');
  });
  it('stays quiet for all-ERC-20, missing split data, and garbage', () => {
    expect(holdingSplitLabel({ creditBalance: '0', erc20Balance: String(10n ** 18n) })).toBeNull();
    expect(holdingSplitLabel({})).toBeNull();
    expect(holdingSplitLabel(null)).toBeNull();
    expect(holdingSplitLabel({ creditBalance: 'garbage', erc20Balance: '1' })).toBeNull();
  });
});

describe('capNote', () => {
  it('surfaces truncation when the indexer holds more rows than the single page fetched', () => {
    expect(capNote(500, 1234, 'token balances')).toBe('Showing the first 500 of 1234 token balances.');
    expect(capNote(1000, 1001, 'items')).toBe('Showing the first 1000 of 1001 items.');
  });
  it('stays quiet when everything fit (or totalCount is unavailable)', () => {
    expect(capNote(12, 12, 'items')).toBeNull();
    expect(capNote(12, 5, 'items')).toBeNull(); // total <= fetched → nothing was cut off
    expect(capNote(12, null, 'items')).toBeNull();
    expect(capNote(12, undefined, 'items')).toBeNull();
  });
});

describe('distinctProjectRefs', () => {
  it('dedupes by (chainId, projectId) in first-seen order and skips non-project events', () => {
    const events = [
      { chainId: 1, projectId: 3 },
      { chainId: 8453, projectId: 3 },
      { chainId: 1, projectId: 3 },
      { chainId: 1, projectId: 0 }, // no project
      { chainId: 1 }, // missing
      { chainId: 10, projectId: 7 },
    ];
    expect(distinctProjectRefs(events)).toEqual([
      { chainId: 1, projectId: 3 },
      { chainId: 8453, projectId: 3 },
      { chainId: 10, projectId: 7 },
    ]);
    expect(distinctProjectRefs(null)).toEqual([]);
  });
});

describe('projectStubsFromRows', () => {
  it('builds interpreter stubs keyed by chain:project, reading the ERC-20 from the deploy event', () => {
    const rows = [
      { chainId: 1, projectId: 3, name: 'Revnet Network', handle: null, deployErc20Events: { items: [{ symbol: 'REV', token: '0x3dd8' }] } },
      { chainId: 10, projectId: 9, name: null, handle: 'no-token', deployErc20Events: { items: [] } },
    ];
    const map = projectStubsFromRows(rows);
    expect(map['1:3']).toMatchObject({ chainId: 1, projectId: 3, name: 'Revnet Network', tokenSymbol: 'REV', tokenAddress: '0x3dd8' });
    // No ERC-20 deployed → symbol omitted so the interpreter falls back to "tokens".
    expect(map['10:9']).toMatchObject({ name: 'no-token', tokenSymbol: null, tokenAddress: null });
    expect(map['1:3'].chains).toEqual([]);
    expect(projectStubsFromRows(null)).toEqual({});
  });
});

describe('dedupeOwnedProjects', () => {
  it('merges direct and Safe-owned rows, direct rows winning the (chainId, projectId) slot', () => {
    const direct = [{ chainId: 1, projectId: 5, name: 'Mine' }];
    const viaSafe = [
      { chainId: 1, projectId: 5, name: 'Mine', safe: '0xsafe' }, // dup of a direct row
      { chainId: 8453, projectId: 2, name: 'Safe project', safe: '0xsafe' },
    ];
    const rows = dedupeOwnedProjects(direct, viaSafe);
    expect(rows).toHaveLength(2);
    expect(rows[0].safe).toBeUndefined();
    expect(rows[1]).toMatchObject({ chainId: 8453, projectId: 2, safe: '0xsafe' });
    expect(dedupeOwnedProjects(null, null)).toEqual([]);
  });
});

describe('groupOperatedProjects', () => {
  it('groups grants by project, unions permissions, flags revnet operators, drops cleared grants', () => {
    const items = [
      { chainId: 1, projectId: 4, account: '0xaaa', operator: '0xop', permissions: ['2', '10'], isRevnetOperator: false },
      { chainId: 1, projectId: 4, account: '0xbbb', operator: '0xop', permissions: [10, 24], isRevnetOperator: true },
      { chainId: 1, projectId: 9, account: '0xccc', operator: '0xop', permissions: [], isRevnetOperator: true }, // stale
      { chainId: 10, projectId: 4, account: '0xaaa', operator: '0xop', permissions: [5], isRevnetOperator: false },
    ];
    const groups = groupOperatedProjects(items);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ chainId: 1, projectId: 4, isRevnetOperator: true, permsUnion: [2, 10, 24] });
    expect(groups[0].grants).toHaveLength(2);
    expect(groups[1]).toMatchObject({ chainId: 10, projectId: 4, isRevnetOperator: false, permsUnion: [5] });
    expect(groupOperatedProjects(null)).toEqual([]);
  });
});

describe('safesForOwner', () => {
  it('lists Safes from the transaction service owners endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ safes: ['0x1111111111111111111111111111111111111111'] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(safesForOwner(ADDR, 1)).resolves.toEqual(['0x1111111111111111111111111111111111111111']);
    // The address is checksummed before hitting the service (it 422s otherwise).
    expect(fetchMock.mock.calls[0][0].toLowerCase())
      .toBe(('https://api.safe.global/tx-service/eth/api/v1/owners/' + ADDR + '/safes/').toLowerCase());
  });
  it('returns [] for chains without a Safe service and throws on service errors', async () => {
    await expect(safesForOwner(ADDR, 999999)).resolves.toEqual([]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(safesForOwner(ADDR, 1)).rejects.toThrow(/HTTP 500/);
  });
});

describe('listRelayrPendingScopes', () => {
  // Receipts are wallet-scoped (see relayr-scope.test.js for the connected-wallet contract): with no
  // wallet connected there is no identity to scope by, so the account view lists nothing — but a
  // feature that knows its own scope can still restore a legacy unkeyed receipt for read-only recovery.
  it('lists nothing while no wallet is connected, without breaking direct scope recovery', () => {
    localStorage.clear();
    localStorage.setItem('jb-relayr-pending-v1:create:draft1', JSON.stringify({ bundleUuid: 'b-1', records: [], chains: [] }));
    localStorage.setItem('jb-relayr-pending-v1:shop:1:5', JSON.stringify({ bundleUuid: 'b-2', records: [], chains: [] }));
    localStorage.setItem('jb-network', 'mainnet');
    expect(listRelayrPendingScopes()).toEqual([]);
    expect(loadRelayrPendingSession('create:draft1').bundleUuid).toBe('b-1');
    localStorage.clear();
  });
});

describe('renderAccountView', () => {
  it('renders a friendly error card for an unresolvable route', () => {
    document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
    renderAccountView('not-an-address');
    const tab = document.getElementById('tab-account');
    expect(tab.textContent).toMatch(/Could not resolve "not-an-address"/);
    expect(tab.querySelector('.account-viewas input')).not.toBeNull();
  });
  it('renders header + tab bar for a valid address, defaulting to Activity and degrading gracefully offline', async () => {
    document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
    renderAccountView(ADDR);
    const tab = document.getElementById('tab-account');
    expect(tab.querySelector('.account-avatar')).not.toBeNull();
    // Project-page tab idiom: one .detail-tab-btn per account tab, Activity active by default.
    const btns = [...tab.querySelectorAll('.project-detail-tabs .detail-tab-btn')];
    expect(btns.map(b => b.dataset.tab)).toEqual(['activity', 'holdings', 'projects', 'roles']);
    expect(btns[0].classList.contains('active')).toBe(true);
    expect(tab.textContent).toContain('Activity');
    await vi.waitFor(() => {
      expect(tab.textContent).toMatch(/Could not load activity from Bendystraw/);
    });
  });
  it('shows a back-to-Discover affordance so #account routes (no active nav tab) are not a dead end', () => {
    document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
    renderAccountView(ADDR);
    const tab = document.getElementById('tab-account');
    const back = tab.querySelector('.account-back');
    expect(back).not.toBeNull();
    expect(back.title).toMatch(/projects/i);
    location.hash = '#account/' + ADDR;
    back.click();
    expect(['', '#']).toContain(location.hash);
    // The affordance survives the invalid-route card too.
    renderAccountView('not-an-address');
    expect(document.querySelector('#tab-account .account-back')).not.toBeNull();
  });
  it('opens the routed tab and switches panes on tab clicks', async () => {
    document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
    renderAccountView(ADDR + '/holdings');
    const tab = document.getElementById('tab-account');
    const btns = [...tab.querySelectorAll('.detail-tab-btn')];
    expect(btns.find(b => b.dataset.tab === 'holdings').classList.contains('active')).toBe(true);
    expect(tab.textContent).toContain('Tokens');
    expect(tab.textContent).toContain('Store items');
    await vi.waitFor(() => {
      expect(tab.textContent).toMatch(/Could not load token balances from Bendystraw/);
      expect(tab.textContent).toMatch(/Could not load store items from Bendystraw/);
    });
    // Click through the mapped legacy sections: Projects (owned) and Roles (operated).
    btns.find(b => b.dataset.tab === 'projects').click();
    expect(tab.textContent).toContain('Owned projects');
    await vi.waitFor(() => expect(tab.textContent).toMatch(/No V6 projects owned by this account/));
    btns.find(b => b.dataset.tab === 'roles').click();
    expect(tab.textContent).toContain('Operated projects');
    await vi.waitFor(() => expect(tab.textContent).toMatch(/Could not read permissions from Bendystraw/));
    // Tab clicks update the hash without retriggering the router.
    expect(location.hash).toBe('#account/' + ADDR + '/roles');
  });
});
