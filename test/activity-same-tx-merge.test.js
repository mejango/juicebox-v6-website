// Same-tx activity rows collapse into ONE line item: the buyback route emits a pay and a
// pool swap in one transaction, which must read as a single sentence attributed to the
// payer (not two rows, one pinned on the tx-submitting bundler EOA).
import { describe, it, expect } from 'vitest';
import { activityRowFromEvent, mergeSameTxActivityRows, projectFeedRowsFromEvents, reservePercentLabel } from '../src/discover.js';

const project = { tokenSymbol: 'ART', tokenAddress: '0x44c4516768e47cd97cff2561b81a74699f23f8ec' };

function payRow(overrides) {
  return Object.assign({
    type: 'pay', direction: 'in', chainId: 8453, txHash: '0xtx', timestamp: 1,
    account: '0xpayer', from: '0xpayer', baseAmount: '20 USDC', tokenAmount: '',
    action: 'paid into ART', memo: 'gm',
  }, overrides || {});
}

function swapRow(overrides) {
  return Object.assign({
    type: 'swap', direction: 'in', chainId: 8453, txHash: '0xtx', timestamp: 1,
    account: '0xbundler', from: '0xbundler', baseAmount: '20 USDC', tokenAmount: '',
    action: 'bought 28k ART via the buyback pool', memo: '',
  }, overrides || {});
}

describe('mergeSameTxActivityRows', () => {
  it('folds a same-tx pay + swap into one row attributed to the payer', () => {
    const merged = mergeSameTxActivityRows([swapRow(), payRow()], project);
    expect(merged).toHaveLength(1);
    expect(merged[0].account).toBe('0xpayer');
    // The zero-issuance pay anchors the row (actor, amount, memo) but its
    // "paid into ART" contributes no phrase — the amount + "in" tag say that.
    expect(merged[0].action).toBe('bought 28k ART via the buyback pool');
    expect(merged[0].actionParts).toEqual(['bought 28k ART via the buyback pool']);
    expect(merged[0].memo).toBe('gm');
    expect(merged[0].direction).toBe('in');
  });

  it('keeps different txs, chains, and system rows separate', () => {
    const rows = mergeSameTxActivityRows([
      payRow(),
      payRow({ txHash: '0xother' }),
      payRow({ chainId: 1 }),
      { type: 'ruleset', system: true, chainId: 8453, txHash: '0xtx', timestamp: 1, action: 'queued a ruleset', tokenAmount: '', memo: '' },
    ], project);
    expect(rows).toHaveLength(4);
  });

  it('explains the reserved-rate remint on the buyback swap row', () => {
    // 20 USDC → 28,406 gross from the pool, 17,043 reminted to the payer = 40% reserve.
    const withRemint = Object.assign({}, project, {
      _remintByTx: { '8453:0xbb': ['17043000000000000000000'] },
    });
    const row = activityRowFromEvent({
      chainId: 8453, txHash: '0xbb', timestamp: 1, from: '0xpayer',
      swapEvent: { terminalTokenAmount: '20000000', projectTokenAmount: '28406000000000000000000', from: '0xpayer', timestamp: 1, txHash: '0xbb' },
    }, withRemint);
    expect(row.action).toBe('bought 28.4k ART via the buyback pool, receiving 17k ART after the 40% reserve');
  });

  it('pairs each buy swap in a tx with the mint at the same position', () => {
    function swap(amount) {
      return { chainId: 8453, txHash: '0xbb', timestamp: 1, from: '0xpayer',
        swapEvent: { terminalTokenAmount: '20000000', projectTokenAmount: amount, from: '0xpayer', timestamp: 1, txHash: '0xbb' } };
    }
    function mint(count) {
      return { chainId: 8453, txHash: '0xbb', timestamp: 1, from: '0xpayer',
        mintTokensEvent: { beneficiary: '0xpayer', beneficiaryTokenCount: count, caller: '0xhook', from: '0xhook', txHash: '0xbb', timestamp: 1 } };
    }
    const rows = projectFeedRowsFromEvents([
      swap('28406000000000000000000'), mint('17043000000000000000000'),
      swap('1000000000000000000000'), mint('875000000000000000000'),
    ], Object.assign({}, project));
    expect(rows.map(r => r.action)).toEqual([
      'bought 28.4k ART via the buyback pool, receiving 17k ART after the 40% reserve',
      'bought 1k ART via the buyback pool, receiving 875 ART after the 12.5% reserve',
    ]);

    // More mints than swaps still pairs the leading ones.
    const extra = projectFeedRowsFromEvents([
      swap('28406000000000000000000'), mint('17043000000000000000000'), mint('5'),
    ], Object.assign({}, project));
    expect(extra).toHaveLength(1);
    expect(extra[0].action).toMatch(/receiving 17k ART after the 40% reserve$/);
  });

  it('computes the reserve percent only for a sane swap/mint pair', () => {
    expect(reservePercentLabel('28406000000000000000000', '17043000000000000000000')).toBe('40');
    expect(reservePercentLabel('1000', '875')).toBe('12.5');
    expect(reservePercentLabel('1000', '1000')).toBe('');
    expect(reservePercentLabel('0', '10')).toBe('');
    expect(reservePercentLabel('1000', null)).toBe('');
  });

  it('inlines a fragment token amount with the unit', () => {
    const mint = payRow({ type: 'issuance', account: '0xpayer', action: 'received', tokenAmount: '17k', baseAmount: '' });
    const bridge = payRow({ type: 'bridge_claim', action: 'claimed ART from Base', tokenAmount: '2k' });
    const merged = mergeSameTxActivityRows([bridge, mint], project);
    expect(merged[0].action).toBe('received 17k ART and claimed ART from Base 2k ART');
    expect(merged[0].tokenAmount).toBe('');
  });
});
