// The one-transaction band move: BURN_POSITION + MINT_POSITION + CLOSE x2 in a single
// modifyLiquidities plan, with the mint sized inside the burn's proceeds so the credit
// always covers it (no Permit2, no msg.value).
import { describe, it, expect } from 'vitest';
import { decodeAbiParameters } from 'viem';
import { lpBandPricesOf, prepareMoveLiquidity } from '../src/discover.js';

const ACCT = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const HOOK = '0x3333333333333333333333333333333333333333';

const pos = {
  tokenId: 42n,
  key: {
    currency0: '0x0000000000000000000000000000000000000000',
    currency1: TOKEN,
    fee: 3000,
    tickSpacing: 60,
    hooks: HOOK,
  },
  poolId: '0x' + '44'.repeat(32),
  pair: { decimals: 18, symbol: 'ETH' },
  pairIsC0: true,
  tickLower: -60,
  tickUpper: 60,
  liquidity: 100n,
  pairAmt: 1_000_000_000_000_000_000n,
  tokAmt: 1_000_000_000_000_000_000n,
  sqrtP: 2n ** 96n,
  smartWallet: false,
};

describe('LP band move', () => {
  it('composes burn + mint + closes in one plan, funded by the burn credit', () => {
    const prep = prepareMoveLiquidity(1, pos, ACCT, 0.25, 4);
    const [actions, params] = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      prep.unlockData,
    );
    expect(actions).toBe('0x03021212');
    expect(params).toHaveLength(4);
    expect(prep.value).toBe(0n);

    // Burn: the old tokenId with 95% output floors mapped by currency order.
    const [tokenId, amount0Min, amount1Min] = decodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'bytes' }],
      params[0],
    );
    expect(tokenId).toBe(42n);
    expect(amount0Min).toBe(prep.pairMin);
    expect(amount1Min).toBe(prep.tokenMin);
    expect(prep.pairMin).toBe((pos.pairAmt * 9_500n) / 10_000n);

    // Mint: sized inside the burn's proceeds so the credit always covers it.
    expect(prep.liquidity > 0n).toBe(true);
    expect(prep.pairMax <= pos.pairAmt).toBe(true);
    expect(prep.tokenMax <= pos.tokAmt).toBe(true);
    const [poolKey, tickLower, tickUpper, , amount0Max, amount1Max, recipient] =
      decodeAbiParameters(
        [
          { type: 'tuple', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }] },
          { type: 'int24' }, { type: 'int24' }, { type: 'uint256' }, { type: 'uint128' }, { type: 'uint128' }, { type: 'address' }, { type: 'bytes' },
        ],
        params[1],
      );
    expect(poolKey[1].toLowerCase()).toBe(TOKEN);
    expect(tickLower).toBe(prep.tickLower);
    expect(tickUpper).toBe(prep.tickUpper);
    expect(amount0Max).toBe(prep.pairMax);
    expect(amount1Max).toBe(prep.tokenMax);
    expect(recipient.toLowerCase()).toBe(ACCT);

    // Closes settle both currencies at the end.
    expect(decodeAbiParameters([{ type: 'address' }], params[2])[0]).toBe(pos.key.currency0);
    expect(decodeAbiParameters([{ type: 'address' }], params[3])[0].toLowerCase()).toBe(TOKEN);
  });

  it('rejects an invalid range and maps ticks back to display prices', () => {
    expect(() => prepareMoveLiquidity(1, pos, ACCT, 4, 0.25)).toThrow(/valid positive price range/);
    // pairIsC0 flips the axis: the lower tick is the HIGHER display price.
    const band = lpBandPricesOf(pos);
    expect(band.min).toBeLessThan(band.max);
    expect(band.min).toBeCloseTo(1.0001 ** -60, 6);
    expect(band.max).toBeCloseTo(1.0001 ** 60, 6);
  });
});
