// Ambient cash-out figures (You-card cash out column, Composition unit value) are net of the 2.5%
// protocol fee, matching the cash-out modal's exact quote. Surfaces that cannot cheaply net (the floor
// chip over a plotted history) carry an explicit "before fees" qualifier instead.
import { describe, it, expect } from 'vitest';
import {
  ambientNetCashOut, cashOutFloorTip, cashOutProtocolFee,
  ambientCashOutDisplay, taxRateFromRulesetResult,
} from '../src/discover.js';

describe('ambientNetCashOut', () => {
  it('nets the full 2.5% fee for a non-zero cash out tax (gross − floor(gross/40))', () => {
    expect(ambientNetCashOut(4000n, 5000, 0n)).toBe(4000n - 4000n / 40n);
    expect(ambientNetCashOut(4001n, 4000, 0n)).toBe(4001n - 4001n / 40n); // floor division
  });

  it('matches the modal fee helper exactly', () => {
    const gross = 123456789n;
    expect(ambientNetCashOut(gross, 4000, 0n)).toBe(gross - cashOutProtocolFee(gross, 4000, false, 0n));
    expect(ambientNetCashOut(gross, 0, 5000n)).toBe(gross - cashOutProtocolFee(gross, 0, false, 5000n));
  });

  it('zero tax: fee applies only up to the fee-free surplus', () => {
    expect(ambientNetCashOut(4000n, 0, 1000n)).toBe(4000n - 25n); // min(4000, 1000)/40
    expect(ambientNetCashOut(4000n, 0, 0n)).toBe(4000n); // no fee-free surplus → no fee
  });

  it('passes null/zero through unchanged', () => {
    expect(ambientNetCashOut(null, 5000, 0n)).toBeNull();
    expect(ambientNetCashOut(undefined, 5000, 0n)).toBeUndefined();
    expect(ambientNetCashOut(0n, 5000, 0n)).toBe(0n);
  });
});

describe('ambientCashOutDisplay — degrades to a MARKED gross when the fee-free read failed', () => {
  it('zero tax + fee-free read failed (null): the gross passes through flagged beforeFees, never faked as net', () => {
    const d = ambientCashOutDisplay(4000n, 0, null);
    expect(d.value).toBe(4000n);
    expect(d.beforeFees).toBe(true);
  });

  it('zero tax + fee-free read succeeded: nets exactly like ambientNetCashOut, unflagged', () => {
    const d = ambientCashOutDisplay(4000n, 0, 1000n);
    expect(d.value).toBe(ambientNetCashOut(4000n, 0, 1000n));
    expect(d.beforeFees).toBe(false);
    const zero = ambientCashOutDisplay(4000n, 0, 0n); // verified zero fee-free surplus → no fee, still net
    expect(zero.value).toBe(4000n);
    expect(zero.beforeFees).toBe(false);
  });

  it('non-zero tax needs no fee-free read: nets the full 2.5% regardless of the fee-free argument', () => {
    const d = ambientCashOutDisplay(4000n, 5000, null);
    expect(d.value).toBe(4000n - 4000n / 40n);
    expect(d.beforeFees).toBe(false);
  });

  it('null/zero gross pass through unflagged', () => {
    expect(ambientCashOutDisplay(null, 0, null)).toEqual({ value: null, beforeFees: false });
    expect(ambientCashOutDisplay(0n, 0, null)).toEqual({ value: 0n, beforeFees: false });
  });
});

describe('taxRateFromRulesetResult — each chain\'s OWN ruleset tax, not the home chain\'s', () => {
  it('reads metadata.cashOutTaxRate from a decoded [ruleset, metadata] pair', () => {
    expect(taxRateFromRulesetResult([{ weight: 1n }, { cashOutTaxRate: 2500n }], 0)).toBe(2500);
    expect(taxRateFromRulesetResult([{ weight: 1n }, { cashOutTaxRate: 0 }], 5000)).toBe(0); // an explicit 0 is a real answer
  });

  it('reads an object-shaped result too', () => {
    expect(taxRateFromRulesetResult({ ruleset: {}, metadata: { cashOutTaxRate: 100 } }, 0)).toBe(100);
  });

  it('falls back when the result is missing or carries no metadata', () => {
    expect(taxRateFromRulesetResult(null, 4000)).toBe(4000);
    expect(taxRateFromRulesetResult([{}, {}], 4000)).toBe(4000);
    expect(taxRateFromRulesetResult(undefined, 0)).toBe(0);
  });
});

describe('cash out floor chip qualifier', () => {
  it('labels the un-netted floor quote as before fees', () => {
    const tip = cashOutFloorTip(0.0001, 'ETH', 'REV');
    expect(tip).toContain('ETH');
    expect(tip).toContain('REV');
    expect(tip).toMatch(/before .*fee/i);
  });
});
