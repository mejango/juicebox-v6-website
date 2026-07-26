// Cash out floor math for the settlement price chart: the live quote (with the own-share bonus)
// vs the dashed minimum it approaches — (1 − tax) × balance ÷ supply.
import { describe, it, expect } from 'vitest';
import {
  calculateFloorPrice,
  calculateFloorMinPrice,
  calculatePaymentFloorPrice,
  explainCashOutChange,
  formatCutPercent,
} from '../src/discover.js';

// Real project state (Base Sepolia #11 "BEN", 2026-07-13): backing pinned at the 0.0001 ETH/BEN
// issuance rate, 40% cash out tax.
const BAL = 1013906664594272n;        // ~0.0010139 ETH
const SUP = 10138952920494645629n;    // ~10.139 BEN
const TAX = 4000;                     // 40% in bps

describe('cash out floor price', () => {
  it('quotes the marginal 1-token cash out on the bonding curve', () => {
    const v = calculateFloorPrice(BAL, SUP, TAX, 18);
    expect(v).toBeGreaterThan(0.0000639);
    expect(v).toBeLessThan(0.0000645); // matches the observed 0.000064 ETH/BEN
  });
  it('minimum is (1 − tax) × balance ÷ supply, always below the live quote', () => {
    const min = calculateFloorMinPrice(BAL, SUP, TAX, 18);
    expect(min).toBeCloseTo(0.00006, 7); // (1 − 0.40) × 0.0001
    expect(min).toBeLessThan(calculateFloorPrice(BAL, SUP, TAX, 18));
  });
  it('live quote converges to the minimum as supply grows', () => {
    const small = calculateFloorPrice(BAL, SUP, TAX, 18) - calculateFloorMinPrice(BAL, SUP, TAX, 18);
    const bigger = calculateFloorPrice(BAL * 100n, SUP * 100n, TAX, 18) - calculateFloorMinPrice(BAL * 100n, SUP * 100n, TAX, 18);
    expect(bigger).toBeGreaterThan(0);
    expect(bigger).toBeLessThan(small / 50);
  });
  it('zero tax: quote equals the minimum (pure pro-rata)', () => {
    expect(calculateFloorPrice(BAL, SUP, 0, 18)).toBeCloseTo(calculateFloorMinPrice(BAL, SUP, 0, 18), 12);
  });
});

describe('payment floor price', () => {
  it('is issuance price times the post-tax factor', () => {
    expect(calculatePaymentFloorPrice(0.0001, 4000)).toBeCloseTo(0.00006, 12);
  });

  it('rises with an increasing issuance price at a fixed tax', () => {
    expect(calculatePaymentFloorPrice(0.00011, 4000)).toBeGreaterThan(
      calculatePaymentFloorPrice(0.0001, 4000),
    );
  });
});

describe('issuance cut formatting', () => {
  it('does not round a non-zero daily cut to zero', () => {
    expect(formatCutPercent(9_496)).toBe('0.0009496%');
  });
});

describe('cash-out change explanation', () => {
  it('explains when a payment dilutes backing per token', () => {
    expect(explainCashOutChange(
      { balance: 100n, tokenSupply: 100n, cashOutTax: 4000, price: 0.6 },
      { balance: 150n, tokenSupply: 200n, cashOutTax: 4000, price: 0.45 },
    )).toContain('increased token supply faster than backing');
  });
});
