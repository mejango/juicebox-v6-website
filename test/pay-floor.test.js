// payMinTokens is the pay floor (minReturnedTokens). It returns 0 EXACTLY when the preview is missing — which is
// the floorless case DSS-R02-C032 flagged. doPay now blocks submit when the preview isn't ready/non-null, so a 0
// here only reaches the tx for add-to-balance (no tokens) or a genuine 0-issuance project (shown as "You get 0").
import { describe, it, expect } from 'vitest';
import { payMinTokens } from '../src/discover.js';

describe('payMinTokens (pay floor)', () => {
  it('missing preview → 0 (the floorless case the submit guard now blocks)', () => {
    expect(payMinTokens(null, 500)).toBe(0n);
    expect(payMinTokens({ received: null, routing: 'issuance' }, 500)).toBe(0n);
  });
  it('issuance (mint) route → the exact quote, no haircut (deterministic)', () => {
    expect(payMinTokens({ received: 1000n, routing: 'issuance' }, 500)).toBe(1000n);
    expect(payMinTokens({ received: 1000n, routing: 'issuance' }, 0)).toBe(1000n);
  });
  it('amm route → quote minus the chosen slippage (the guaranteed floor)', () => {
    expect(payMinTokens({ received: 1000n, routing: 'amm' }, 500)).toBe(950n);  // 5%
    expect(payMinTokens({ received: 1000n, routing: 'amm' }, 100)).toBe(990n);  // 1%
    expect(payMinTokens({ received: 1000n, routing: 'amm' }, 0)).toBe(1000n);
  });
  it('genuine 0-issuance → 0 (allowed: shown as "You get 0", not a floorless surprise)', () => {
    expect(payMinTokens({ received: 0n, routing: 'issuance' }, 500)).toBe(0n);
  });
});
