import { describe, expect, it } from 'vitest';
import { toEventSelector } from 'viem';
import {
  lpCollectPoolLogs,
  lpDefaultRange,
  lpDepthMarkerLabelLayout,
  renderLpDepthChart,
} from '../src/discover.js';

const INITIALIZE = toEventSelector('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)');
const MODIFY = toEventSelector('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)');
const POOL_ID = `0x${'ab'.repeat(32)}`;
const POSITION_MANAGER = `0x${'12'.repeat(20)}`;

function indexedAddress(address) {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function modifyLog(sender, tokenId, blockNumber = 101n) {
  return {
    topics: [MODIFY, POOL_ID, indexedAddress(sender)],
    data: `0x${'0'.repeat(192)}${tokenId.toString(16).padStart(64, '0')}`,
    blockNumber: `0x${blockNumber.toString(16)}`,
  };
}

describe('Uniswap V4 LP history parsing', () => {
  it('anchors history at Initialize and accepts only the configured PositionManager sender', () => {
    const state = { initializeBlock: null, tokenIds: {} };
    lpCollectPoolLogs([
      { topics: [INITIALIZE, POOL_ID], data: '0x', blockNumber: '0x64' },
      modifyLog(`0x${'34'.repeat(20)}`, 77n),
      modifyLog(POSITION_MANAGER, 42n),
    ], POSITION_MANAGER, state);

    expect(state.initializeBlock).toBe(100n);
    expect(state.tokenIds['42']).toEqual({ id: 42n, block: 101n });
    expect(state.tokenIds['77']).toBeUndefined();
  });

  it('rejects malformed matching logs instead of silently dropping positions', () => {
    const state = { initializeBlock: null, tokenIds: {} };
    expect(() => lpCollectPoolLogs([{
      topics: [MODIFY, POOL_ID, indexedAddress(POSITION_MANAGER)],
      data: '0x1234',
      blockNumber: '0x65',
    }], POSITION_MANAGER, state)).toThrow(/Malformed ModifyLiquidity/);
  });
});

describe('LP depth marker labels', () => {
  it('renders liquidity bands when the pair token is currency1', () => {
    const panel = renderLpDepthChart({
      positions: [{ tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n }],
      sqrtP: 1n << 96n,
      pairIsC0: false,
      pair: { decimals: 18, symbol: 'USDC' },
    }, 1, 1.05, 0.95, 'ART');

    expect(panel.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('stacks clustered floor, price, and ceiling labels without moving their markers', () => {
    const clustered = lpDepthMarkerLabelLayout([
      { x: 274, label: 'floor' },
      { x: 278, label: 'price' },
      { x: 299, label: 'ceiling' },
    ], 300);
    expect(new Set(clustered.map(label => label.row)).size).toBe(3);
    expect(clustered.every(label => label.x > 0 && label.x < 300)).toBe(true);
  });

  it('keeps labels on one row when their text does not collide', () => {
    const spread = lpDepthMarkerLabelLayout([
      { x: 30, label: 'floor' },
      { x: 150, label: 'price' },
      { x: 270, label: 'ceiling' },
    ], 300);
    expect(spread.map(label => label.row)).toEqual([0, 0, 0]);
  });
});

describe('LP default price range', () => {
  it('keeps the economic corridor when it strictly contains the pool price', () => {
    expect(lpDefaultRange(0.01, 0.005, 0.02)).toEqual({ min: 0.005, max: 0.02, economic: true });
  });

  it('widens around spot when floor and ceiling are inverted or meet spot', () => {
    const range = lpDefaultRange(0.01, 0.0101, 0.01);
    expect(range.economic).toBe(false);
    expect(range.min).toBeLessThan(0.01);
    expect(range.max).toBeGreaterThan(0.01);
  });
});
