// Account view pure helpers: route parsing, activity project-stub building, owned-project dedupe,
// operated-project grouping — plus the safe-owner listing and the Relayr pending-scope enumeration
// the view is built on. DOM rendering is exercised through the offline-safe error paths.
import { describe, it, expect, vi } from 'vitest';
import {
  parseAccountRoute, distinctProjectRefs, projectStubsFromRows, dedupeOwnedProjects,
  groupOperatedProjects, renderAccountView,
} from '../src/account-view.js';
import { listRelayrPendingScopes, loadRelayrPendingSession } from '../src/relayr.js';
import { safesForOwner } from '../src/safe.js';

const ADDR = '0x823b92d6A4b2AED4b15675c7917c9f922ea8ADAd';

describe('parseAccountRoute', () => {
  it('accepts a 0x address (and URI-encoded input)', () => {
    expect(parseAccountRoute(ADDR)).toEqual({ address: ADDR });
    expect(parseAccountRoute(encodeURIComponent(' ' + ADDR + ' '))).toEqual({ address: ADDR });
  });
  it('accepts an ENS name, lowercased', () => {
    expect(parseAccountRoute('Jango.ETH')).toEqual({ ens: 'jango.eth' });
    expect(parseAccountRoute('team.banny.eth')).toEqual({ ens: 'team.banny.eth' });
  });
  it('rejects garbage', () => {
    expect(parseAccountRoute('')).toBeNull();
    expect(parseAccountRoute(null)).toBeNull();
    expect(parseAccountRoute('0x123')).toBeNull(); // short hex
    expect(parseAccountRoute('12345')).toBeNull();
    expect(parseAccountRoute('0xnothexnothexnothexnothexnothexnothexnothe')).toBeNull();
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
  it('enumerates only jb-relayr-pending-v1: keys, returning the feature scope', () => {
    localStorage.clear();
    localStorage.setItem('jb-relayr-pending-v1:create:draft1', JSON.stringify({ bundleUuid: 'b-1', records: [], chains: [] }));
    localStorage.setItem('jb-relayr-pending-v1:shop:1:5', JSON.stringify({ bundleUuid: 'b-2', records: [], chains: [] }));
    localStorage.setItem('jb-network', 'mainnet');
    const scopes = listRelayrPendingScopes().sort();
    expect(scopes).toEqual(['create:draft1', 'shop:1:5']);
    expect(loadRelayrPendingSession(scopes[0]).bundleUuid).toBe('b-1');
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
  it('renders header + sections for a valid address, degrading gracefully offline', async () => {
    document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
    renderAccountView(ADDR);
    const tab = document.getElementById('tab-account');
    expect(tab.querySelector('.account-avatar')).not.toBeNull();
    expect(tab.textContent).toContain('Activity');
    expect(tab.textContent).toContain('Owned projects');
    expect(tab.textContent).toContain('Operated projects');
    await vi.waitFor(() => {
      expect(tab.textContent).toMatch(/Could not load activity from Bendystraw/);
      expect(tab.textContent).toMatch(/No V6 projects owned by this account/);
      expect(tab.textContent).toMatch(/Could not read permissions from Bendystraw/);
    });
  });
});
