// Cash-out protocol fee mirrors JBMultiTerminal._cashOutTokensOf: non-zero cash-out tax fees the FULL reclaim;
// ZERO tax fees ONLY min(reclaim, feeFreeSurplus) (round-trip prevention). Before this fix the zero-tax case
// always showed 0, understating the fee whenever the project had received an inter-project payout.
import { describe, it, expect } from 'vitest';
import { cashOutProtocolFee } from '../src/discover.js';

describe('cashOutProtocolFee', () => {
  it('non-zero tax → 2.5% of the full reclaim (feeFreeSurplus irrelevant)', () => {
    expect(cashOutProtocolFee(4000n, 5000, false, 0n)).toBe(100n);   // 4000/40
    expect(cashOutProtocolFee(4000n, 5000, false, 1000n)).toBe(100n); // still full
  });
  it('zero tax + no fee-free surplus → no fee (the common path)', () => {
    expect(cashOutProtocolFee(4000n, 0, false, 0n)).toBe(0n);
  });
  it('zero tax + fee-free surplus < reclaim → fee on the surplus portion only', () => {
    expect(cashOutProtocolFee(4000n, 0, false, 1000n)).toBe(25n); // 1000/40, not 4000/40
  });
  it('zero tax + fee-free surplus >= reclaim → fee on the full reclaim', () => {
    expect(cashOutProtocolFee(4000n, 0, false, 9999n)).toBe(100n); // min(4000, 9999)/40
  });
  it('feeless casher → 0 regardless of tax / surplus', () => {
    expect(cashOutProtocolFee(4000n, 5000, true, 0n)).toBe(0n);
    expect(cashOutProtocolFee(4000n, 0, true, 4000n)).toBe(0n);
  });
  it('zero / null reclaim → 0', () => {
    expect(cashOutProtocolFee(0n, 5000, false, 0n)).toBe(0n);
    expect(cashOutProtocolFee(null, 0, false, 1000n)).toBe(0n);
  });
});
