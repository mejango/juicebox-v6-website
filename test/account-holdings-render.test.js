// Account Holdings tab rendered against fixture bendystraw data: V6-pinned queries, hook-keyed
// NFT identity (same-chain tokenId collisions across collections both render), the credit/ERC-20
// split beside each combined balance, and complete offset pagination.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderAccountView } from '../src/account-view.js';
import { bendystrawQuery } from '../src/bendystraw-client.js';

vi.mock('../src/bendystraw-client.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, bendystrawQuery: vi.fn() };
});

const ADDR = '0x823b92d6A4b2AED4b15675c7917c9f922ea8ADAd';
const E18 = 10n ** 18n;
const HOOK_A = '0xaaaa000000000000000000000000000000000001';
const HOOK_B = '0xbbbb000000000000000000000000000000000002';

function primeQueries({ participants, nfts, pageSize }) {
  bendystrawQuery.mockImplementation((query, vars) => {
    if (query.indexOf('participants(') !== -1) {
      expect(vars.version).toBe(6); // V6-only site: the pin must actually be sent
      const items = pageSize
        ? participants.items.slice(vars.offset, vars.offset + pageSize)
        : participants.items;
      return Promise.resolve({ participants: { ...participants, items } });
    }
    if (query.indexOf('nfts(') !== -1) {
      expect(vars.version).toBe(6);
      const items = pageSize ? nfts.items.slice(vars.offset, vars.offset + pageSize) : nfts.items;
      return Promise.resolve({ nfts: { ...nfts, items } });
    }
    return Promise.reject(new Error('offline'));
  });
}

function mountHoldings() {
  document.body.innerHTML = '<section id="tab-account" class="tab-content"></section>';
  renderAccountView(ADDR + '/holdings');
  return document.getElementById('tab-account');
}

describe('holdings tab rendering', () => {
  beforeEach(() => { bendystrawQuery.mockReset(); });

  it('renders token rows with the credit/ERC-20 split and both same-tokenId collections', async () => {
    primeQueries({
      participants: {
        totalCount: 2,
        items: [
          { chainId: 1, projectId: 3, version: 6, balance: String(900n * E18), creditBalance: String(100n * E18), erc20Balance: String(800n * E18) },
          { chainId: 1, projectId: 9, version: 6, balance: String(5n * E18), creditBalance: String(5n * E18), erc20Balance: '0' },
        ],
      },
      nfts: {
        totalCount: 2,
        items: [
          // Same chain, same JB721 tokenId, DIFFERENT collections (projects 3 and 7): both must render.
          { chainId: 1, projectId: 3, hook: { address: HOOK_A }, tokenId: '3000000001', tierId: 3 },
          { chainId: 1, projectId: 7, hook: { address: HOOK_B }, tokenId: '3000000001', tierId: 3 },
        ],
      },
    });
    const tab = mountHoldings();
    await vi.waitFor(() => {
      expect(tab.querySelectorAll('.account-holding-balance').length).toBe(2);
    });
    const splits = [...tab.querySelectorAll('.account-holding-split')].map((n) => n.textContent);
    expect(splits.some((t) => t.includes('ERC-20') && t.includes('credits'))).toBe(true);
    expect(splits.some((t) => t.includes('credits (unclaimed)'))).toBe(true);
    // NFT card: one row per (chain, project) — the tokenId collision must NOT collapse them.
    await vi.waitFor(() => {
      const nftCard = [...tab.querySelectorAll('.detail-card')].find((c) => c.textContent.includes('Store items'));
      expect(nftCard.querySelectorAll('.account-proj-row').length).toBe(2);
      expect(nftCard.textContent).toContain('#3');
      expect(nftCard.textContent).toContain('#7');
    });
    // Nothing truncated → no cap note anywhere.
    expect(tab.textContent).not.toContain('Showing the first');
  });

  it('loads every offset page instead of surfacing a truncated holdings window', async () => {
    primeQueries({
      participants: {
        totalCount: 2,
        items: [
          { chainId: 1, projectId: 3, version: 6, balance: String(2n * E18), creditBalance: '0', erc20Balance: String(2n * E18) },
          { chainId: 8453, projectId: 9, version: 6, balance: String(E18), creditBalance: String(E18), erc20Balance: '0' },
        ],
      },
      nfts: {
        totalCount: 2,
        items: [
          { chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '3000000001', tierId: 3 },
          { chainId: 1, projectId: 7, hook: HOOK_B, tokenId: '4000000001', tierId: 4 },
        ],
      },
      pageSize: 1,
    });
    const tab = mountHoldings();
    await vi.waitFor(() => {
      expect(tab.querySelectorAll('.account-holding-balance')).toHaveLength(2);
      const nftCard = [...tab.querySelectorAll('.detail-card')].find((c) => c.textContent.includes('Store items'));
      expect(nftCard.querySelectorAll('.account-proj-row')).toHaveLength(2);
    });
    expect(tab.textContent).not.toContain('Showing the first');
    expect(bendystrawQuery.mock.calls.some(([, vars]) => vars.offset === 1)).toBe(true);
  });
});
