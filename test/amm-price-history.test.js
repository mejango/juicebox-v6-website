import { describe, expect, it } from 'vitest';
import {
  BENDYSTRAW_BUYBACK_POOL_EVENTS_QUERY,
  BENDYSTRAW_BUYBACK_POOL_LIQUIDITY_EVENTS_QUERY,
  BENDYSTRAW_LEGACY_SWAP_EVENTS_QUERY,
  BENDYSTRAW_SWAP_EVENTS_QUERY,
  ammPriceFromSqrtPriceX96,
  formatPrice,
  replayPoolReserves,
} from '../src/discover.js';
import { componentReproPrompt } from '../src/component-base.js';
import { bucketPoolReserves } from '../src/time-series.js';

describe('Uniswap V4 AMM price history', () => {
  it('converts ART pool sqrt prices into USDC per ART', () => {
    const initial = ammPriceFromSqrtPriceX96(
      0x2af49f5c8594347614n,
      true,
      6,
    );
    const afterTrade = ammPriceFromSqrtPriceX96(
      800571923982999312419n,
      true,
      6,
    );

    expect(initial).toBeCloseTo(0.0001000274, 10);
    expect(afterTrade).toBeCloseTo(0.0001021037, 10);
    expect(afterTrade).toBeGreaterThan(initial);
  });

  it('shows enough precision to distinguish the ART move', () => {
    expect(formatPrice(0.0001000274)).not.toBe(formatPrice(0.0001021037));
  });

  // Scoping pool history by suckerGroupId made it depend on the indexer's project
  // row, a slow query behind a short soft timeout. When that row failed the series
  // came back empty and the chart claimed there were no trades.
  it('scopes pool history by poolId, never by sucker group', () => {
    for (const query of [
      BENDYSTRAW_SWAP_EVENTS_QUERY,
      BENDYSTRAW_LEGACY_SWAP_EVENTS_QUERY,
      BENDYSTRAW_BUYBACK_POOL_EVENTS_QUERY,
      BENDYSTRAW_BUYBACK_POOL_LIQUIDITY_EVENTS_QUERY,
    ]) {
      expect(query).toContain('$poolId: String!');
      expect(query).toContain('poolId: $poolId');
      expect(query).toContain('chainId: $chainId');
      expect(query).not.toContain('suckerGroupId');
    }
  });

  it('copies the complete Bendystraw V4 history contract into the chart build prompt', () => {
    const prompt = componentReproPrompt(
      'Issuance, cash out, and AMM price history',
      'price-history',
    );

    expect(prompt).toContain('buybackPoolEvents');
    expect(prompt).toContain('swapEvents');
    expect(prompt).toContain('version: 6');
    expect(prompt).toContain('initialSqrtPriceX96');
    expect(prompt).toContain('sqrtPriceX96');
    expect(prompt).toContain('projectTokenIsCurrency0');
    expect(prompt).toContain('exact POST-TRADE Uniswap V4 spot');
    expect(prompt).toContain('10^(18-terminalDecimals)');
    expect(prompt).toContain('realized average-price fallback, NOT an exact spot');
    expect(prompt).toContain('retry the legacy swap selection');
    expect(prompt).toContain("Ignore direction='mint'");
    expect(prompt).toContain('buybackPoolLiquidityEvents');
    expect(prompt).toContain('liquidityAfter');
    expect(prompt).toContain('AT THE HOVERED TIMESTAMP');
  });

  it('replays pool reserves at every change and trade, then buckets them with last-observation hold', () => {
    const Q96 = 1n << 96n;
    const fullRange = { tickLower: -887220, tickUpper: 887220 };
    const events = [
      { timestamp: 100, tokenId: '1', liquidityAfter: '1000000000000000000', sqrtPriceX96: String(Q96), ...fullRange },
      { timestamp: 200, tokenId: '2', liquidityAfter: '1000000000000000000', sqrtPriceX96: String(Q96 * 2n), ...fullRange },
      { timestamp: 400, tokenId: '1', liquidityAfter: '0', sqrtPriceX96: String(Q96), ...fullRange },
    ];
    const prices = [
      { timestamp: 50, sqrtPriceX96: String(Q96) },
      { timestamp: 200, sqrtPriceX96: String(Q96 * 2n) },
      { timestamp: 300, sqrtPriceX96: String(Q96) },
    ];

    const points = replayPoolReserves(events, prices, true, 18);

    // The trade at 50 predates any liquidity; the change at 200 applies before that second's trade.
    expect(points.map(point => point.timestamp)).toEqual([100, 200, 200, 300, 400]);
    expect(points[0].tokenAmount).toBeCloseTo(1, 6);
    expect(points[0].pairAmount).toBeCloseTo(1, 6);
    expect(points[0].tokenValue).toBeCloseTo(1, 6);
    expect(points[1].tokenAmount).toBeCloseTo(1, 6);
    expect(points[1].pairAmount).toBeCloseTo(4, 6);
    expect(points[2]).toMatchObject({ tokenAmount: points[1].tokenAmount, pairAmount: points[1].pairAmount });
    expect(points[3].tokenAmount).toBeCloseTo(2, 6);
    expect(points[3].tokenValue).toBeCloseTo(2, 6);
    expect(points[4].tokenAmount).toBeCloseTo(1, 6);
    expect(points[4].pairAmount).toBeCloseTo(1, 6);

    const buckets = bucketPoolReserves(points, 0, 400, 4);
    expect(buckets.map(bucket => bucket.timestamp)).toEqual([150, 250, 350]);
    expect(buckets.map(bucket => bucket.pairValue)).toEqual([points[0].pairValue, points[2].pairValue, points[3].pairValue]);
  });
});
