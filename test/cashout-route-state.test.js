import { describe, expect, it } from 'vitest';
import { encodeAbiParameters } from 'viem';
import {
  applyCashOutPreviewQuote,
  cashOutDirectRouteWins,
  cashOutExecutableMinimum,
  cashOutExecutionErrorMessage,
  cashOutPoolBufferBps,
  cashOutPreviewRulesetId,
  resolveCashOutPreviewRoute,
} from '../src/discover.js';

const BUYBACK = '0x1111111111111111111111111111111111111111';
const OTHER_HOOK = '0x2222222222222222222222222222222222222222';
const buybackSpec = ({ minimum = 16_000_000n, direct = 9_750_000n, raw = 16_419_630n, userSpecified = false } = {}) =>
  encodeAbiParameters([
    { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'int24' },
    { type: 'uint128' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bool' },
  ], [minimum, 100n, direct, 0, 1n, `0x${'00'.repeat(32)}`, raw, userSpecified]);

const preview = ({ reclaim = 10_000_000n, tax = 1n, hook = BUYBACK, noop = true, metadata = buybackSpec() } = {}) => [
  { id: 42n }, reclaim, tax, [{ hook, noop, amount: 0n, metadata }],
];

describe('cash out route state', () => {
  it('uses the selected pool quote for submit validation, even when treasury output is zero', () => {
    const state = { net: 0n, outcome: null };
    const quote = { net: 10_040_000n, route: 'directsell', treasuryNet: 0n };

    applyCashOutPreviewQuote(state, quote, { symbol: 'USDC', decimals: 6 });

    expect(state.net).toBe(10_040_000n);
    expect(state.outcome).toMatchObject({ net: 10_040_000n, sym: 'USDC', decimals: 6 });
  });

  it('protects the hook executable quote instead of the optimistic pool quote', () => {
    expect(cashOutExecutableMinimum(16_000_000n, 100)).toBe(15_840_000n);
    expect(cashOutPoolBufferBps(16_419_630n, 16_000_000n)).toBe(256);
  });

  it('nets the protocol fee before flooring a treasury route', () => {
    const route = resolveCashOutPreviewRoute(preview(), BUYBACK, 100, false, 0n);
    expect(route).toMatchObject({ via: 'treasury', expected: 9_750_000n, terminalMinimum: 9_652_500n });
  });

  it('only interprets an active specification from the exact buyback hook', () => {
    expect(resolveCashOutPreviewRoute(preview({ hook: OTHER_HOOK, noop: false }), BUYBACK, 100, false, 0n).via).toBe('treasury');
    expect(resolveCashOutPreviewRoute(preview({ noop: true }), BUYBACK, 100, false, 0n).via).toBe('treasury');
    const route = resolveCashOutPreviewRoute(preview({ reclaim: 0n, tax: 10_000n, noop: false }), BUYBACK, 100, false, 0n);
    expect(route).toMatchObject({ via: 'amm', expected: 16_419_630n, minimum: 15_840_000n, terminalMinimum: 0n });
    expect(route.metadata).not.toBe('0x');
  });

  it('preserves a user-specified hook minimum instead of flooring it twice', () => {
    const route = resolveCashOutPreviewRoute(preview({ reclaim: 0n, tax: 10_000n, noop: false, metadata: buybackSpec({ minimum: 15_500_000n, userSpecified: true }) }), BUYBACK, 300, false, 0n);
    expect(route.minimum).toBe(15_500_000n);
  });

  it('lets a direct swap win only when its protected minimum beats the full terminal quote', () => {
    expect(cashOutDirectRouteWins(16_100_000n, 16_000_000n, 100, 100n, 100n)).toBe(false);
    expect(cashOutDirectRouteWins(16_300_000n, 16_000_000n, 100, 100n, 100n)).toBe(true);
    expect(cashOutDirectRouteWins(16_300_000n, 16_000_000n, 100, 99n, 100n)).toBe(false);
  });

  it('extracts the ruleset id used to lock an AMM route', () => {
    expect(cashOutPreviewRulesetId(preview())).toBe(42n);
  });

  it('explains the buyback slippage selector', () => {
    expect(cashOutExecutionErrorMessage('reverted with signature 0xe2d708a9')).toMatch(/pool moved below your protected minimum/i);
  });

  it('explains the terminal minimum selector without blaming slippage alone', () => {
    const message = cashOutExecutionErrorMessage('reverted with signature 0x6b2bb382');
    expect(message).toMatch(/below your minimum/i);
    // UnderMin also fires when the hook flips the route between treasury and pool at
    // execution. Naming only the price movement invited users to lower their slippage floor
    // in response to a route change, which is the wrong lever.
    expect(message).toMatch(/route/i);
  });
});
