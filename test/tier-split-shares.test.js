// A tier's split group must total EXACTLY 1e9 (JBSplits.sol:232-236). Per-row rounding alone doesn't:
// three equal thirds sum to 999,999,999 and other sets round over. The add-tiers call reverts on that,
// and it reverts AFTER the item metadata has already been pinned to IPFS — so the user pays for a pin
// and then hits an opaque onchain failure. These pin the normalization that prevents it.
import { describe, expect, it } from 'vitest';
import { tierSplitShares } from '../src/discover.js';

const SPLITS_TOTAL = 1_000_000_000;
const sum = (shares) => shares.reduce((acc, v) => acc + v, 0);

describe('tierSplitShares', () => {
  it('normalizes three equal thirds up to exactly 1e9', () => {
    const shares = tierSplitShares([{ pct: 1 }, { pct: 1 }, { pct: 1 }], 3);
    expect(sum(shares)).toBe(SPLITS_TOTAL);
    expect(shares).toHaveLength(3);
  });

  it('normalizes a set whose rounding overshoots back down to 1e9', () => {
    // Each row rounds up individually; unnormalized this sums past the cap and reverts.
    const shares = tierSplitShares([{ pct: 1 }, { pct: 1 }, { pct: 1 }, { pct: 1 }, { pct: 1 }, { pct: 1 }], 6);
    expect(sum(shares)).toBe(SPLITS_TOTAL);
  });

  it('leaves clean percentages exactly as written', () => {
    expect(tierSplitShares([{ pct: 60 }, { pct: 40 }], 100)).toEqual([600_000_000, 400_000_000]);
  });

  it('puts the remainder on the largest row so relative order is preserved', () => {
    const shares = tierSplitShares([{ pct: 1 }, { pct: 1 }, { pct: 98 }], 100);
    expect(sum(shares)).toBe(SPLITS_TOTAL);
    expect(shares[2]).toBeGreaterThan(shares[0]);
    expect(shares[2]).toBeGreaterThan(shares[1]);
  });

  it('handles a single row and an empty list', () => {
    expect(tierSplitShares([{ pct: 100 }], 100)).toEqual([SPLITS_TOTAL]);
    expect(tierSplitShares([], 100)).toEqual([]);
  });
});
