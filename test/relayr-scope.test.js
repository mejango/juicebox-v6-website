// Relayr pending receipts are device-local AND wallet-local: storage keys carry the connected
// account, so wallet B on the same browser never sees (or resumes) wallet A's paid bundles.
// Pre-existing unkeyed entries are adopted, best-effort, by the first wallet that reads them.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ account: null }));

vi.mock('../src/wallet.js', () => ({
  getAccount: vi.fn(() => h.account),
  getWalletClient: vi.fn(() => null),
  createPublicClientForChain: vi.fn(() => null),
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  onWalletChange: vi.fn(),
  switchChain: vi.fn(),
  eagerConnect: vi.fn(),
  getProviders: vi.fn(() => []),
  refreshProviders: vi.fn(),
  isSafeConnected: vi.fn(() => false),
  proposeSafeTransactions: vi.fn(),
  waitForSafeInitialization: vi.fn(() => Promise.resolve()),
  initSafeApp: vi.fn(() => Promise.resolve(null)),
  getSafeInfo: vi.fn(() => null),
  dispatchWalletChangeListeners: vi.fn(),
}));

import {
  saveRelayrPendingSession, loadRelayrPendingSession, listRelayrPendingScopes, clearRelayrPendingSession,
} from '../src/relayr.js';

const A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PREFIX = 'jb-relayr-pending-v1:';

function session(uuid) {
  return { bundleUuid: uuid, expectedCount: 2, chains: [{ id: 1, name: 'Ethereum' }], records: [], itemCount: 1 };
}

beforeEach(() => {
  localStorage.clear();
  h.account = null;
});

describe('account-keyed Relayr pending scopes', () => {
  it('keeps wallet A receipts invisible to wallet B, and intact for A', () => {
    h.account = A;
    saveRelayrPendingSession('create-project', session('bundle-a'));
    expect(listRelayrPendingScopes()).toEqual(['create-project']);
    expect(loadRelayrPendingSession('create-project').bundleUuid).toBe('bundle-a');

    h.account = B;
    expect(listRelayrPendingScopes()).toEqual([]);
    expect(loadRelayrPendingSession('create-project')).toBeNull();

    h.account = A;
    expect(loadRelayrPendingSession('create-project').bundleUuid).toBe('bundle-a');
  });

  it('stores under a key carrying the lowercased account address', () => {
    h.account = A;
    saveRelayrPendingSession('scope-x', session('bundle-x'));
    expect(localStorage.getItem(PREFIX + A.toLowerCase() + ':scope-x')).toBeTruthy();
    expect(localStorage.getItem(PREFIX + 'scope-x')).toBeNull();
  });

  it('adopts a legacy unkeyed receipt into the first connected wallet, best-effort', () => {
    localStorage.setItem(PREFIX + 'create-project', JSON.stringify(session('bundle-legacy')));
    h.account = A;
    expect(listRelayrPendingScopes()).toEqual(['create-project']);
    const restored = loadRelayrPendingSession('create-project');
    expect(restored.bundleUuid).toBe('bundle-legacy');
    // Migrated: legacy key gone, account key present; wallet B still sees nothing.
    expect(localStorage.getItem(PREFIX + 'create-project')).toBeNull();
    expect(localStorage.getItem(PREFIX + A.toLowerCase() + ':create-project')).toBeTruthy();
    h.account = B;
    expect(loadRelayrPendingSession('create-project')).toBeNull();
  });

  it('does not duplicate a scope while both a legacy and an adopted copy exist', () => {
    localStorage.setItem(PREFIX + 'create-project', JSON.stringify(session('bundle-legacy')));
    h.account = A;
    saveRelayrPendingSession('create-project', session('bundle-new'));
    expect(listRelayrPendingScopes()).toEqual(['create-project']);
  });

  it('clear removes both the account-keyed and any legacy copy', () => {
    localStorage.setItem(PREFIX + 'create-project', JSON.stringify(session('bundle-legacy')));
    h.account = A;
    saveRelayrPendingSession('create-project', session('bundle-new'));
    clearRelayrPendingSession('create-project');
    expect(localStorage.getItem(PREFIX + 'create-project')).toBeNull();
    expect(localStorage.getItem(PREFIX + A.toLowerCase() + ':create-project')).toBeNull();
    expect(loadRelayrPendingSession('create-project')).toBeNull();
  });

  it('falls back to unkeyed storage when no wallet is connected (nothing to key by)', () => {
    saveRelayrPendingSession('create-project', session('bundle-anon'));
    expect(localStorage.getItem(PREFIX + 'create-project')).toBeTruthy();
    expect(loadRelayrPendingSession('create-project').bundleUuid).toBe('bundle-anon');
    // Disconnected browsing lists nothing account-scoped.
    expect(listRelayrPendingScopes()).toEqual([]);
  });
});
