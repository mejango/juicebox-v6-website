// LP fee math: the pool's fee-growth accumulators are unchecked uint256 and wrap by design, and the position key
// must match what PoolManager stores or the read silently returns an empty position.
import { describe, it, expect } from 'vitest';
import { lpFeesOwed, lpPositionKey } from '../src/discover.js';

// The ART/USDC pool's only LP on Base (token id 2864727), read at block 49458950.
const BASE_POSITION_MANAGER = '0x7c5f5a4bbd8fd63184577525326123b519429bdc';
const LIQUIDITY = 143800072655163317n;
const FEE_GROWTH_INSIDE_1 = 32541020662148266151501820090n;

describe('lpPositionKey', () => {
  it('derives the key PoolManager stores the position under', () => {
    expect(lpPositionKey(BASE_POSITION_MANAGER, -392200, -340600, 2864727n))
      .toBe('0x34bf69524209147fed65f9af6b1b20091647aff24618aeb98279c5b48767e734');
  });
});

describe('lpFeesOwed', () => {
  it('computes the live position’s unclaimed fees', () => {
    expect(lpFeesOwed(LIQUIDITY, 0n, FEE_GROWTH_INSIDE_1)).toBe(13751523n); // 13.751523 USDC
  });

  it('treats a wrapped accumulator as forward progress', () => {
    // A plain subtraction here would report a colossal negative instead of 8.
    const max = (1n << 256n) - 1n;
    expect(lpFeesOwed(1n << 128n, max - 3n, 4n)).toBe(8n);
  });

  it('reports nothing for a closed position or an unmoved checkpoint', () => {
    expect(lpFeesOwed(0n, 0n, FEE_GROWTH_INSIDE_1)).toBe(0n);
    expect(lpFeesOwed(LIQUIDITY, FEE_GROWTH_INSIDE_1, FEE_GROWTH_INSIDE_1)).toBe(0n);
  });
});
