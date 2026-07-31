import { describe, expect, it } from 'vitest';
import {
  applyCashOutPreviewQuote,
  cashOutExecutableMinimum,
  cashOutExecutionErrorMessage,
  cashOutPoolBufferBps,
  cashOutTreasuryFallbackNet,
} from '../src/discover.js';

describe('cash out route state', () => {
  it('uses the selected pool quote for submit validation, even when treasury output is zero', () => {
    const state = { net: 0n, outcome: null };
    const quote = { net: 10_040_000n, route: 'directsell', treasuryNet: 0n };

    applyCashOutPreviewQuote(state, quote, { symbol: 'USDC', decimals: 6 });

    expect(state.net).toBe(10_040_000n);
    expect(state.outcome).toMatchObject({ net: 10_040_000n, sym: 'USDC', decimals: 6 });
  });

  it('uses the treasury quote—not the displayed pool quote—if a pool route disappears', () => {
    expect(cashOutTreasuryFallbackNet({ via: 'directsell', treasuryNet: 0n }, 10_040_000n)).toBe(0n);
    expect(cashOutTreasuryFallbackNet({ via: 'amm', treasuryNet: 4_000_000n }, 10_040_000n)).toBe(4_000_000n);
    expect(cashOutTreasuryFallbackNet({ via: 'treasury' }, 4_000_000n)).toBe(4_000_000n);
  });

  it('protects the hook executable quote instead of the optimistic pool quote', () => {
    expect(cashOutExecutableMinimum(16_000_000n, 100)).toBe(15_840_000n);
    expect(cashOutPoolBufferBps(16_419_630n, 16_000_000n)).toBe(256);
  });

  it('explains the buyback slippage selector', () => {
    expect(cashOutExecutionErrorMessage('reverted with signature 0xe2d708a9')).toMatch(/pool moved below your protected minimum/i);
  });
});
