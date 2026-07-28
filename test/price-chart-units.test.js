// Price-chart unit discipline: the issuance ladder is denominated in the ruleset's baseCurrency
// (ETH=1 / USD=2 convention) while AMM spot and the cash-out floor are pair/accounting-token units
// (currency = uint32(uint160(token))). One chart axis must never mix the two: when they differ the
// issuance series is converted through JBPrices, or dropped when no feed exists.
import { describe, expect, it } from 'vitest';
import { issuancePairUnitMismatch, convertIssuanceStagesToPairUnits, lpDefaultRange } from '../src/discover.js';

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

describe('convertIssuanceStagesToPairUnits', () => {
  it('scales stage weights so 1/weight prices land in pair units (rate = pair per base unit)', () => {
    // weight 1000 tokens per USD; rate 2 USDC per USD → price should double: 0.001 → 0.002.
    const stages = [{ start: 0, weight: 1000e18, weightCutPercent: 0, duration: 0 }];
    const converted = convertIssuanceStagesToPairUnits(stages, 2);
    expect(Number(converted[0].weight) / 1e18).toBeCloseTo(500);
    // Original untouched (shared with project.stages).
    expect(Number(stages[0].weight) / 1e18).toBeCloseTo(1000);
    // Non-weight fields survive.
    expect(converted[0].duration).toBe(0);
  });
  it('is the identity at rate 1', () => {
    const stages = [{ start: 5, weight: 7e18 }];
    expect(Number(convertIssuanceStagesToPairUnits(stages, 1)[0].weight)).toBe(7e18);
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
