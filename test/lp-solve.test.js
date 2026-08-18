import { describe, expect, it } from 'vitest';
import { lpAmountsModeNote, lpFullRangeBounds, lpSolveRangeFromAmounts } from '../src/discover.js';

// The solver turns "I have X project tokens and Y pair tokens" into a concrete
// price range. It pins the floor at the cash-out price and solves the ceiling;
// when the token side is too heavy for any ceiling, it pins the ceiling at the
// issuance price and solves the floor instead. Round-tripped below through the
// independent lpCounterpart-style math.

const PRICE = 0.00001;
const FLOOR = 6.68961e-8;
const CEILING = 0.0016;

// Independent V3/V4 counterpart math (mirrors lpCounterpart, which is module-private).
function counterpartToken(pairAmount, p, pa, pb) {
  const sp = Math.sqrt(p), sa = Math.sqrt(pa), sb = Math.sqrt(pb);
  const L = pairAmount / (sp - sa);
  return L * (1 / sp - 1 / sb);
}

const relDiff = (a, b) => Math.abs(a - b) / Math.max(a, b);

describe('lpSolveRangeFromAmounts', () => {
  it('pins the floor and solves the ceiling when the token side fits', () => {
    const solved = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 1000,
      pairAmount: 0.08,
      floorHint: FLOOR,
    });
    expect(solved).not.toBeNull();
    expect(solved.anchor).toBe('floor');
    expect(solved.minPrice).toBe(FLOOR);
    expect(solved.maxPrice).toBeGreaterThan(PRICE);
    expect(relDiff(counterpartToken(0.08, PRICE, solved.minPrice, solved.maxPrice), 1000)).toBeLessThan(1e-3);
  });

  it('pins the ceiling and solves the floor when the token side is too heavy', () => {
    const solved = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100000,
      pairAmount: 0.08,
      floorHint: FLOOR,
      ceilingHint: CEILING,
    });
    expect(solved).not.toBeNull();
    expect(solved.anchor).toBe('ceiling');
    expect(solved.maxPrice).toBe(CEILING);
    expect(solved.minPrice).toBeGreaterThan(FLOOR);
    expect(solved.minPrice).toBeLessThan(PRICE);
    expect(relDiff(counterpartToken(0.08, PRICE, solved.minPrice, solved.maxPrice), 100000)).toBeLessThan(1e-3);
  });

  it('degrades to single-sided positions when one amount is zero', () => {
    const pairOnly = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 0,
      pairAmount: 0.08,
      floorHint: FLOOR,
    });
    expect(pairOnly.anchor).toBe('floor');
    expect(pairOnly.minPrice).toBe(FLOOR);
    expect(pairOnly.maxPrice).toBe(PRICE);

    const tokenOnly = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100000,
      pairAmount: 0,
      floorHint: FLOOR,
      ceilingHint: CEILING,
    });
    expect(tokenOnly.anchor).toBe('ceiling');
    expect(tokenOnly.minPrice).toBe(PRICE);
    expect(tokenOnly.maxPrice).toBe(CEILING);
  });

  it('falls back to spot/2 and spot*2 when hints are unusable', () => {
    const solved = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 1000,
      pairAmount: 0.08,
      floorHint: PRICE * 3,
    });
    expect(solved.minPrice).toBeCloseTo(PRICE / 2, 12);
    const heavy = lpSolveRangeFromAmounts({
      price: PRICE,
      tokenAmount: 100000,
      pairAmount: 0.08,
      floorHint: FLOOR,
      ceilingHint: PRICE / 2,
    });
    expect(heavy.maxPrice).toBeCloseTo(PRICE * 2, 10);
  });

  it('returns null for degenerate inputs', () => {
    expect(lpSolveRangeFromAmounts({ price: PRICE, tokenAmount: 0, pairAmount: 0 })).toBeNull();
    expect(lpSolveRangeFromAmounts({ price: 0, tokenAmount: 1, pairAmount: 1 })).toBeNull();
    expect(lpSolveRangeFromAmounts({ price: PRICE, tokenAmount: -1, pairAmount: 1 })).toBeNull();
    expect(lpSolveRangeFromAmounts({ price: PRICE, tokenAmount: NaN, pairAmount: 1 })).toBeNull();
  });
});

describe('lpAmountsModeNote', () => {
  const note = (tokenAmount, pairAmount, floorHint, ceilingHint) =>
    lpAmountsModeNote({
      tokenAmount,
      pairAmount,
      solved: lpSolveRangeFromAmounts({ price: PRICE, tokenAmount, pairAmount, floorHint, ceilingHint }),
      floorHint,
      ceilingHint,
      tokenSymbol: 'MARKEE',
      pairSymbol: 'ETH',
    });

  it('prompts when nothing is entered', () => {
    expect(note(0, 0, FLOOR, CEILING)).toContain('Enter');
  });

  it('explains each anchor and fallback', () => {
    expect(note(1000, 0.08, FLOOR, CEILING)).toContain('cash-out');
    expect(note(1000, 0.08, null, CEILING)).toContain('half the current price');
    expect(note(100000, 0.08, FLOOR, CEILING)).toContain('issuance');
    expect(note(100000, 0.08, FLOOR, null)).toContain('twice the current price');
  });

  it('explains single-sided deposits', () => {
    expect(note(0, 0.08, FLOOR, CEILING)).toContain('below the current price');
    expect(note(100000, 0, FLOOR, CEILING)).toContain('above the current price');
  });
});

describe('lpFullRangeBounds', () => {
  it('spans nine orders of magnitude around spot and yields the v2 pool ratio', () => {
    const bounds = lpFullRangeBounds(PRICE);
    expect(bounds).not.toBeNull();
    expect(bounds.minPrice).toBeCloseTo(PRICE / 1e9, 20);
    expect(bounds.maxPrice).toBeCloseTo(PRICE * 1e9, 2);
    expect(relDiff(counterpartToken(0.08, PRICE, bounds.minPrice, bounds.maxPrice), 0.08 / PRICE)).toBeLessThan(1e-3);
  });

  it('returns null without a live price', () => {
    expect(lpFullRangeBounds(0)).toBeNull();
    expect(lpFullRangeBounds(NaN)).toBeNull();
  });
});
