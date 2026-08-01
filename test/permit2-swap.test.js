import { describe, expect, it } from 'vitest';
import {
  directPaySwapQuoteIfBetter,
  permit2AllowanceCovers,
  permit2SignatureNeedsOnchainFallback,
} from '../src/discover.js';

describe('direct-swap Permit2 authorization', () => {
  it('uses the direct V4 quote instead of reconstructing one from the pay preview', () => {
    // Project 6 on Base exposed the regression: pay-route beneficiary +
    // reserves was ~308k ART while the direct V4 quote was ~439k ART.
    expect(directPaySwapQuoteIfBetter(181_824n, 438_924n)).toBe(438_924n);
    expect(directPaySwapQuoteIfBetter(181_824n, 181_824n)).toBeNull();
    expect(directPaySwapQuoteIfBetter(181_824n, null)).toBeNull();
  });

  it('reuses only an amount-sufficient allowance which outlives the send buffer', () => {
    var now = 1_000;
    expect(permit2AllowanceCovers([50_000_000n, 2_000n, 0n], 50_000_000n, now, 60)).toBe(true);
    expect(permit2AllowanceCovers([49_999_999n, 2_000n, 0n], 50_000_000n, now, 60)).toBe(false);
    expect(permit2AllowanceCovers([50_000_000n, 1_060n, 0n], 50_000_000n, now, 60)).toBe(false);
    expect(permit2AllowanceCovers(null, 50_000_000n, now, 60)).toBe(false);
  });

  it('falls back for unsupported typed-data RPCs but never after a user rejection', () => {
    expect(permit2SignatureNeedsOnchainFallback({ code: -32602, message: 'Invalid parameters' })).toBe(true);
    expect(permit2SignatureNeedsOnchainFallback({ cause: { code: 4200, message: 'Unsupported method' } })).toBe(true);
    expect(permit2SignatureNeedsOnchainFallback({ code: 4001, message: 'User rejected the request' })).toBe(false);
    expect(permit2SignatureNeedsOnchainFallback(new Error('Disconnected'))).toBe(false);
  });
});
