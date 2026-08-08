// Price-feed reachability guard: accounting contexts are token-keyed (uint32(uint160(token))) while
// baseCurrency uses standard ids, so the terminal converts between them through JBPrices at runtime —
// pay (context ↔ base, skipped when equal) and cash-outs/surplus (context ↔ context). Contexts are
// immutable, so launching a pair JBPrices can't resolve ships a project whose payments or cash outs
// revert onchain forever. The guard probes every required pair on every selected chain before
// anything is signed, failing closed on both a missing feed (pair named) and a probe outage
// (distinct retry copy — never a silent pass).
import { describe, it, expect, vi } from 'vitest';
import { requiredFeedPairs, feedCurrencyLabel, __test } from '../src/create-flow.js';

const { initState, applyAccountingDefaults, verifyLaunchFeedCoverage } = __test;

const NATIVE = 61166; // uint32(uint160(0x…EEEe))
const USDC_MAINNET = Number(BigInt('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') % (1n << 32n));
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const price = () => Promise.resolve(10n ** 18n);
// Shapes mirror viem: a revert surfaces as ContractFunctionExecutionError ("… reverted."), an
// outage as HttpRequestError — only the former means the feed is actually missing.
const revertErr = () => Object.assign(new Error('The contract function "pricePerUnitOf" reverted.'), { name: 'ContractFunctionExecutionError' });
const rpcErr = () => Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError' });

function ethUsdc() {
  const s = initState();
  s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth', 'usdc'];
  applyAccountingDefaults(s); // the wizard forces base USD(2) when USDC is accepted
  return s;
}

function ethOnly() {
  const s = initState();
  s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth'];
  return s;
}

describe('requiredFeedPairs — the pairs the terminal must resolve', () => {
  const ctxs = [{ currency: NATIVE }, { currency: USDC_MAINNET }];

  it('lists context↔base and context↔context pairs, deduped', () => {
    expect(requiredFeedPairs(ctxs, [2])).toEqual([
      { a: NATIVE, b: 2 }, { a: USDC_MAINNET, b: 2 }, { a: NATIVE, b: USDC_MAINNET },
    ]);
    expect(requiredFeedPairs(ctxs, [2, 2])).toHaveLength(3);
  });

  it('skips equal currencies — the terminal short-circuits, no feed is read', () => {
    expect(requiredFeedPairs([{ currency: NATIVE }], [NATIVE])).toEqual([]);
  });

  it('skips cross-context pairs when asked (the queue guard: contexts are immutable)', () => {
    expect(requiredFeedPairs(ctxs, [2], true)).toEqual([
      { a: NATIVE, b: 2 }, { a: USDC_MAINNET, b: 2 },
    ]);
  });
});

describe('verifyLaunchFeedCoverage — fail-closed launch gate', () => {
  it('blocks an ETH + USDC launch on a missing cross-context feed, naming the pair and chain', async () => {
    const s = ethUsdc();
    const probe = vi.fn((pair) => (pair.a !== 2 && pair.b !== 2) ? Promise.reject(revertErr()) : price());
    await expect(verifyLaunchFeedCoverage(s, 1, probe)).rejects.toThrow(
      /No price feed is registered between ETH and USDC on Ethereum/
    );
    expect(probe).toHaveBeenCalledTimes(3); // 61166↔2, usdc↔2, 61166↔usdc
  });

  it('passes a single-token launch and never probes a cross-context pair', async () => {
    const s = ethOnly();
    const probe = vi.fn(price);
    await verifyLaunchFeedCoverage(s, 1, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith({ a: NATIVE, b: 1 });
  });

  it('probes nothing when every currency equals the base (custom accounting token)', async () => {
    const s = initState();
    s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['custom'];
    s.customToken = { address: DAI, name: 'Dai', symbol: 'DAI', decimals: 18, status: 'ok' };
    applyAccountingDefaults(s); // base currency = the token's own uint32 id → all pairs equal
    const probe = vi.fn(price);
    await verifyLaunchFeedCoverage(s, 1, probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it('blocks with distinct retry copy on a probe outage — never a silent pass', async () => {
    const s = ethUsdc();
    const probe = vi.fn(() => Promise.reject(rpcErr()));
    const err = await verifyLaunchFeedCoverage(s, 1, probe).catch((e) => e);
    expect(err.message).toMatch(/Couldn’t verify price feed coverage on Ethereum right now — nothing was sent\. Try again\./);
    expect(err.message).not.toMatch(/No price feed is registered/);
  });

  it('guards revnet launches through the same pairs (USDC accepted forces base USD)', async () => {
    const s = ethUsdc();
    s.projectType = 'revnet';
    const probe = vi.fn((pair) => (pair.a !== 2 && pair.b !== 2) ? Promise.reject(revertErr()) : price());
    await expect(verifyLaunchFeedCoverage(s, 1, probe)).rejects.toThrow(/ETH and USDC/);
    expect(probe).toHaveBeenCalledTimes(3);
  });
});

describe('feedCurrencyLabel', () => {
  it('names standard ids, the native sentinel, and context symbols', () => {
    expect(feedCurrencyLabel(1, [])).toBe('ETH');
    expect(feedCurrencyLabel(2, [])).toBe('USD');
    expect(feedCurrencyLabel(NATIVE, [])).toBe('ETH');
    expect(feedCurrencyLabel(USDC_MAINNET, [{ currency: USDC_MAINNET, token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC' }])).toBe('USDC');
    expect(feedCurrencyLabel(12345, [])).toBe('currency 12345');
  });
});
