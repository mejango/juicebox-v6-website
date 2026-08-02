import { decodeAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  buildDirectSwapErc20ExecuteTx,
  buildDirectSwapNativeTx,
  directPaySwapQuoteIfBetter,
  nativeSwapConfigForChain,
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
    expect(
      permit2AllowanceCovers([50_000_000n, 2_000n, 0n], 50_000_000n, now, 60),
    ).toBe(true);
    expect(
      permit2AllowanceCovers([49_999_999n, 2_000n, 0n], 50_000_000n, now, 60),
    ).toBe(false);
    expect(
      permit2AllowanceCovers([50_000_000n, 1_060n, 0n], 50_000_000n, now, 60),
    ).toBe(false);
    expect(permit2AllowanceCovers(null, 50_000_000n, now, 60)).toBe(false);
  });

  it('falls back for unsupported typed-data RPCs but never after a user rejection', () => {
    expect(
      permit2SignatureNeedsOnchainFallback({
        code: -32602,
        message: 'Invalid parameters',
      }),
    ).toBe(true);
    expect(
      permit2SignatureNeedsOnchainFallback({
        cause: { code: 4200, message: 'Unsupported method' },
      }),
    ).toBe(true);
    expect(
      permit2SignatureNeedsOnchainFallback({
        code: 4001,
        message: 'User rejected the request',
      }),
    ).toBe(false);
    expect(
      permit2SignatureNeedsOnchainFallback(new Error('Disconnected')),
    ).toBe(false);
  });

  it('builds one atomic Base ETH to USDC to project-token transaction', () => {
    var tx = buildDirectSwapNativeTx(
      8453,
      {
        key: {
          currency0: '0x2222222222222222222222222222222222222222',
          currency1: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          fee: 10000,
          tickSpacing: 200,
          hooks: '0x4444444444444444444444444444444444444444',
        },
        zeroForOne: false,
        pairAddr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        tokenOut: '0x2222222222222222222222222222222222222222',
      },
      10_000_000_000_000_000n,
      100n,
      '0x3333333333333333333333333333333333333333',
      {
        kind: 'native-v3-v4',
        wrappedNative: '0x4200000000000000000000000000000000000006',
        bridgeToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        bridgeTokenSymbol: 'USDC',
        bridgeTokenDecimals: 6,
        v3Fee: 500,
        quotedBridgeAmount: 25_000_000n,
      },
    );

    expect(tx.args[0]).toBe('0x0b0010');
    expect(tx.args[1]).toHaveLength(3);
    expect(tx.value).toBe(10_000_000_000_000_000n);
    var decoded = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      tx.args[1][2],
    );
    expect(decoded[0]).toBe('0x0b060e');
  });

  it('builds one atomic Base USDC to ETH to project-token transaction', () => {
    var tx = buildDirectSwapErc20ExecuteTx(
      8453,
      {
        key: {
          currency0: '0x0000000000000000000000000000000000000000',
          currency1: '0x2222222222222222222222222222222222222222',
          fee: 10000,
          tickSpacing: 200,
          hooks: '0x4444444444444444444444444444444444444444',
        },
        zeroForOne: true,
        pairAddr: '0x0000000000000000000000000000000000000000',
        tokenOut: '0x2222222222222222222222222222222222222222',
      },
      25_000_000n,
      100n,
      '0x3333333333333333333333333333333333333333',
      1_800_000_000,
      undefined,
      {
        kind: 'erc20-v3-native-v4',
        inputToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        wrappedNative: '0x4200000000000000000000000000000000000006',
        bridgeTokenSymbol: 'ETH',
        bridgeTokenDecimals: 18,
        v3Fee: 500,
        quotedBridgeAmount: 10_000_000_000_000_000n,
      },
    );

    expect(tx.args[0]).toBe('0x000c10');
    expect(tx.args[1]).toHaveLength(3);
    expect(tx.value).toBe(0n);
    var decoded = decodeAbiParameters(
      [{ type: 'bytes' }, { type: 'bytes[]' }],
      tx.args[1][2],
    );
    expect(decoded[0]).toBe('0x0b060e');
  });

  it('builds both bridge directions on every supported mainnet', () => {
    [1, 10, 8453, 42161].forEach(function (chainId) {
      var config = nativeSwapConfigForChain(chainId);
      expect(config, 'missing bridge config for chain ' + chainId).toBeTruthy();

      var nativeTx = buildDirectSwapNativeTx(
        chainId,
        {
          key: {
            currency0: '0x2222222222222222222222222222222222222222',
            currency1: config.bridgeToken,
            fee: 10000,
            tickSpacing: 200,
            hooks: '0x4444444444444444444444444444444444444444',
          },
          zeroForOne: false,
          pairAddr: config.bridgeToken,
          tokenOut: '0x2222222222222222222222222222222222222222',
        },
        10_000_000_000_000_000n,
        100n,
        '0x3333333333333333333333333333333333333333',
        {
          kind: 'native-v3-v4',
          wrappedNative: config.wrappedNative,
          bridgeToken: config.bridgeToken,
          bridgeTokenSymbol: 'USDC',
          bridgeTokenDecimals: 6,
          v3Fee: 500,
          quotedBridgeAmount: 25_000_000n,
        },
      );
      expect(nativeTx.chainId).toBe(chainId);
      expect(nativeTx.args[0]).toBe('0x0b0010');

      var erc20Tx = buildDirectSwapErc20ExecuteTx(
        chainId,
        {
          key: {
            currency0: '0x0000000000000000000000000000000000000000',
            currency1: '0x2222222222222222222222222222222222222222',
            fee: 10000,
            tickSpacing: 200,
            hooks: '0x4444444444444444444444444444444444444444',
          },
          zeroForOne: true,
          pairAddr: '0x0000000000000000000000000000000000000000',
          tokenOut: '0x2222222222222222222222222222222222222222',
        },
        25_000_000n,
        100n,
        '0x3333333333333333333333333333333333333333',
        1_800_000_000,
        undefined,
        {
          kind: 'erc20-v3-native-v4',
          inputToken: config.bridgeToken,
          wrappedNative: config.wrappedNative,
          bridgeTokenSymbol: 'ETH',
          bridgeTokenDecimals: 18,
          v3Fee: 500,
          quotedBridgeAmount: 10_000_000_000_000_000n,
        },
      );
      expect(erc20Tx.chainId).toBe(chainId);
      expect(erc20Tx.args[0]).toBe('0x000c10');
    });
  });
});
