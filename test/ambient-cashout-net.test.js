// Ambient cash-out figures (You-card cash out column, Composition unit value) are net of the 2.5%
// protocol fee, matching the cash-out modal's exact quote. Surfaces that cannot cheaply net (the floor
// chip over a plotted history) carry an explicit "before fees" qualifier instead.
import { describe, it, expect } from 'vitest';
import { ambientNetCashOut, cashOutFloorTip, cashOutProtocolFee } from '../src/discover.js';

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

describe('cash out floor chip qualifier', () => {
  it('labels the un-netted floor quote as before fees', () => {
    const tip = cashOutFloorTip(0.0001, 'ETH', 'REV');
    expect(tip).toContain('ETH');
    expect(tip).toContain('REV');
    expect(tip).toMatch(/before .*fee/i);
  });
});
