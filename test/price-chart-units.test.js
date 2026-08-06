// Price-chart unit discipline: the issuance ladder is denominated in the ruleset's baseCurrency
// (ETH=1 / USD=2 convention) while AMM spot and the cash-out floor are pair/accounting-token units
// (currency = uint32(uint160(token))). One chart axis must never mix the two: when they differ the
// issuance series is converted through JBPrices, or dropped when no feed exists.
import { describe, expect, it } from 'vitest';
import { issuancePairUnitMismatch, toBaseAxis, lpDefaultRange } from '../src/discover.js';

const NATIVE = '0x000000000000000000000000000000000000EEEe';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const NATIVE_CUR = Number(BigInt(NATIVE) & 0xffffffffn); // 61166
const USDC_CUR = Number(BigInt(USDC) & 0xffffffffn);

function project(baseCurrency, acct) {
  return { metadata: { baseCurrency }, acctToken: acct };
}

describe('issuancePairUnitMismatch', () => {
  it('treats base ETH(1) with the native accounting token as the SAME unit (61166 vs 1 is a convention gap, not a mismatch)', () => {
    expect(issuancePairUnitMismatch(project(1, { address: NATIVE, currency: NATIVE_CUR, symbol: 'ETH', decimals: 18 }))).toBe(false);
  });
  it('flags USD-based rulesets against an ETH pair (the ART shape)', () => {
    expect(issuancePairUnitMismatch(project(2, { address: NATIVE, currency: NATIVE_CUR, symbol: 'ETH', decimals: 18 }))).toBe(true);
  });
  it('flags USD-based rulesets against a USDC pair (feed conversion, ~1 but not identical)', () => {
    expect(issuancePairUnitMismatch(project(2, { address: USDC, currency: USDC_CUR, symbol: 'USDC', decimals: 6 }))).toBe(true);
  });
  it('matches a custom accounting token priced in its own currency id', () => {
    expect(issuancePairUnitMismatch(project(USDC_CUR, { address: USDC, currency: USDC_CUR, symbol: 'USDC', decimals: 6 }))).toBe(false);
  });
  it('stays quiet when the accounting context is unknown (legacy labeling)', () => {
    expect(issuancePairUnitMismatch(project(2, null))).toBe(false);
    expect(issuancePairUnitMismatch({})).toBe(false);
  });
});

// The chart's axis is the ruleset's BASE currency: issuance (1/weight) is exact in it and is never
// converted, while the pool price and cash-out floor are accounting-token denominated and move onto
// it. Before this, the conversion ran the other way and the axis took the pair token's unit.
describe('toBaseAxis', () => {
  it('converts an accounting-denominated price onto the base-currency axis', () => {
    // 0.0005 ETH per token at 1700 USD per ETH = 0.85 USD per token.
    expect(toBaseAxis(0.0005, 1700)).toBeCloseTo(0.85, 10);
  });
  it('is the identity at the rate a same-currency project gets', () => {
    expect(toBaseAxis(0.0005, 1)).toBe(0.0005);
  });
  it('omits rather than guesses when no feed bridges the units', () => {
    expect(toBaseAxis(0.0005, null)).toBeNull();
    expect(toBaseAxis(null, 1700)).toBeNull();
  });
  it('never yields a non-finite price', () => {
    expect(toBaseAxis(0.0005, Infinity)).toBeNull();
  });
});

describe('lpDefaultRange with a dropped (unit-mismatched, feedless) ceiling', () => {
  it('widens around the pool price instead of consuming a wrong-unit ceiling', () => {
    const range = lpDefaultRange(0.01, 0.005, 0);
    expect(range.economic).toBe(false);
    expect(range.min).toBeCloseTo(0.005);
    expect(range.max).toBeCloseTo(0.02);
  });
});
