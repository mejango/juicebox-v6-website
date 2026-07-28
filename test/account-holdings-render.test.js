// Account Holdings tab rendered against fixture bendystraw data: V6-pinned queries, hook-keyed
// NFT identity (same-chain tokenId collisions across collections both render), the credit/ERC-20
// split beside each combined balance, and an honest "showing first N of M" note when the single
// page the view fetches is smaller than what the indexer holds.
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

function primeQueries({ participants, nfts }) {
  bendystrawQuery.mockImplementation((query, vars) => {
    if (query.indexOf('participants(') !== -1) {
      expect(vars.version).toBe(6); // V6-only site: the pin must actually be sent
      return Promise.resolve({ participants });
    }
    if (query.indexOf('nfts(') !== -1) {
      expect(vars.version).toBe(6);
      return Promise.resolve({ nfts });
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
          { chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '3000000001', tierId: 3 },
          { chainId: 1, projectId: 7, hook: HOOK_B, tokenId: '3000000001', tierId: 3 },
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

  it('surfaces "showing first N of M" when the indexer holds more than one page', async () => {
    primeQueries({
      participants: {
        totalCount: 730,
        items: [{ chainId: 1, projectId: 3, version: 6, balance: String(2n * E18), creditBalance: '0', erc20Balance: String(2n * E18) }],
      },
      nfts: {
        totalCount: 1521,
        items: [{ chainId: 1, projectId: 3, hook: HOOK_A, tokenId: '3000000001', tierId: 3 }],
      },
    });
    const tab = mountHoldings();
    await vi.waitFor(() => {
      expect(tab.textContent).toContain('Showing the first 1 of 730 token balances.');
      expect(tab.textContent).toContain('Showing the first 1 of 1521 store items.');
    });
  });
});
