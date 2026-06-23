// Regression for the fund-loss desync (project 8 / Breadfruit): a USDC-accounting project showed USDC in the
// pay dropdown but built the tx with native ETH (paying 1 ETH instead of 1 USDC). After the on-chain accounting
// refine resolves the real token list, the default token must be the project's accounting token (list[0]) unless
// the USER explicitly picked one — the native-ETH sync default must never shadow it.
import { describe, it, expect } from 'vitest';
import { chooseRefinedPayToken } from '../src/discover.js';

const NATIVE = '0x000000000000000000000000000000000000eeee';
const usdc = { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, viaRouter: false };
const ethDirect = { address: NATIVE, symbol: 'ETH', decimals: 18, viaRouter: false };
const ethRouter = { address: NATIVE, symbol: 'ETH', decimals: 18, viaRouter: true };
const usdcRouter = { address: usdc.address, symbol: 'USDC', decimals: 6, viaRouter: true };

describe('chooseRefinedPayToken — pay-token desync guard', () => {
  it('THE BUG: untouched, project accepts USDC+ETH directly → defaults to USDC (list[0]), not the native sync-default', () => {
    // currentToken is the initial native sync-default; the refined list puts USDC first (the accounting token).
    const chosen = chooseRefinedPayToken([usdc, ethDirect], ethDirect, /*tokenTouched*/ false);
    expect(chosen).toBe(usdc);
    expect(chosen.decimals).toBe(6); // 6 decimals → amount parsed as 1e6, not 1e18
    expect(chosen.viaRouter).toBe(false);
  });

  it('untouched always returns list[0], whatever the current token is', () => {
    expect(chooseRefinedPayToken([usdc, ethDirect], usdc, false)).toBe(usdc);
    expect(chooseRefinedPayToken([ethDirect, usdc], ethDirect, false)).toBe(ethDirect);
    expect(chooseRefinedPayToken([ethDirect, usdc], usdc, false)).toBe(ethDirect);
  });

  it('touched: preserves the user-picked token across the refine', () => {
    expect(chooseRefinedPayToken([usdc, ethDirect], ethDirect, true)).toBe(ethDirect); // user picked ETH
    expect(chooseRefinedPayToken([usdc, ethDirect], usdc, true)).toBe(usdc);
  });

  it('touched but the picked token is gone (chain changed) → falls back to list[0]', () => {
    const stale = { address: '0xdeadbeef', symbol: 'X', decimals: 18, viaRouter: false };
    expect(chooseRefinedPayToken([usdc, ethDirect], stale, true)).toBe(usdc);
  });

  it('viaRouter disambiguates same-address tokens (direct vs swap-via-router)', () => {
    // user picked native-DIRECT, but the refined list only has native-via-ROUTER → not a match → list[0].
    expect(chooseRefinedPayToken([usdcRouter, ethRouter], ethDirect, true)).toBe(usdcRouter);
    // user picked native-via-router and it's present → preserved.
    expect(chooseRefinedPayToken([usdc, ethRouter], ethRouter, true)).toBe(ethRouter);
  });

  it('empty / null list → null', () => {
    expect(chooseRefinedPayToken([], ethDirect, false)).toBe(null);
    expect(chooseRefinedPayToken(null, ethDirect, true)).toBe(null);
  });
});
