// Cross-chain activity token labels: raw pay/cash-out/payout amounts carry no token in the index, so they
// may only be labeled with a token when EVERY chain's terminal has a single accounting context and all of
// them agree on the same token shape (kind, symbol, decimals). A project with 6-dec USDC on one chain and
// an 18-dec context on another would otherwise mislabel remote amounts by 1e12 — those fall back to the
// indexed USD value instead.
import { describe, it, expect } from 'vitest';
import { activityRowFromEvent, flowTokenFromContexts, isProjectFeedActivityRow } from '../src/discover.js';
import { NATIVE_TOKEN } from '../src/component-base.js';

const USDC_BASE = { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, symbol: 'USDC', currency: 1n };
const USDC_OP = { address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC', currency: 1n };
const NATIVE = { address: NATIVE_TOKEN, decimals: 18, symbol: 'ETH', currency: 1n };
const CUSTOM_18 = { address: '0x1111111111111111111111111111111111111111', decimals: 18, symbol: 'JBX', currency: 5n };

function payEventOn(chainId) {
  return {
    chainId: chainId,
    txHash: '0xaa',
    timestamp: 1700000000,
    from: '0xabc0000000000000000000000000000000000abc',
    payEvent: {
      amount: '2500000', // 2.5 USDC in 6-dec raw units; 2.5e-12 in 18-dec units
      amountUsd: '2500000000000000000', // $2.50 (18-dec scaled)
      newlyIssuedTokenCount: '1000000000000000000',
      beneficiary: '0xabc0000000000000000000000000000000000abc',
      timestamp: 1700000000,
      txHash: '0xaa',
    },
  };
}

function buybackEventOn(chainId) {
  return {
    chainId: chainId,
    txHash: '0xbb',
    timestamp: 1700000000,
    from: '0xabc0000000000000000000000000000000000abc',
    swapEvent: {
      terminalTokenAmount: '1859478',
      projectTokenAmount: '4000000000000000000000',
      from: '0xabc0000000000000000000000000000000000abc',
      timestamp: 1700000000,
      txHash: '0xbb',
    },
  };
}

describe('flowTokenFromContexts', () => {
  it('rejects the token label when chains disagree on decimals (6-dec USDC vs 18-dec context)', () => {
    expect(flowTokenFromContexts([[USDC_BASE], [CUSTOM_18]])).toBeNull();
  });

  it('accepts the same token kind across chains even when the per-chain address differs (USDC)', () => {
    expect(flowTokenFromContexts([[USDC_BASE], [USDC_OP]])).toEqual({ symbol: 'USDC', decimals: 6 });
  });

  it('accepts native ETH on every chain', () => {
    expect(flowTokenFromContexts([[NATIVE], [NATIVE]])).toEqual({ symbol: 'ETH', decimals: 18 });
  });

  it('rejects a native context on one chain vs an ERC-20 on another', () => {
    expect(flowTokenFromContexts([[NATIVE], [CUSTOM_18]])).toBeNull();
  });

  it('rejects when any chain has multiple contexts, a failed read, or no contexts', () => {
    expect(flowTokenFromContexts([[USDC_BASE, NATIVE], [USDC_OP]])).toBeNull();
    expect(flowTokenFromContexts([[USDC_BASE], null])).toBeNull();
    expect(flowTokenFromContexts([[USDC_BASE], []])).toBeNull();
    expect(flowTokenFromContexts([])).toBeNull();
    expect(flowTokenFromContexts(null)).toBeNull();
  });
});

describe('activity rows across chains with differing contexts', () => {
  it('keeps holder permission grants out of the project feed', () => {
    const project = { chainId: 8453, tokenSymbol: 'ART' };
    const permission = activityRowFromEvent({
      chainId: 8453,
      txHash: '0xpermission',
      timestamp: 1700000000,
      from: '0xabc0000000000000000000000000000000000abc',
      operatorPermissionsSetEvent: {
        account: '0xabc0000000000000000000000000000000000abc',
        operator: '0x1111111111111111111111111111111111111111',
        timestamp: 1700000000,
        txHash: '0xpermission',
      },
    }, project);

    expect(permission.type).toBe('operator_perms');
    expect(isProjectFeedActivityRow(permission)).toBe(false);
    expect(isProjectFeedActivityRow(activityRowFromEvent(payEventOn(8453), project))).toBe(true);
  });

  it('falls back to the indexed USD value on every chain when contexts are heterogeneous', () => {
    const project = { chainId: 8453, tokenSymbol: 'REV', _flowToken: flowTokenFromContexts([[USDC_BASE], [CUSTOM_18]]) };
    const home = activityRowFromEvent(payEventOn(8453), project);
    const remote = activityRowFromEvent(payEventOn(10), project);
    expect(project._flowToken).toBeNull();
    expect(home.baseAmount).toBe('$2.50');
    expect(remote.baseAmount).toBe('$2.50');
  });

  it('labels raw amounts with the token when every chain agrees on the single context', () => {
    const project = { chainId: 8453, tokenSymbol: 'REV', _flowToken: flowTokenFromContexts([[USDC_BASE], [USDC_OP]]) };
    const home = activityRowFromEvent(payEventOn(8453), project);
    const remote = activityRowFromEvent(payEventOn(10), project);
    expect(home.baseAmount).toContain('USDC');
    expect(home.baseAmount).toContain('2.5');
    expect(remote.baseAmount).toContain('USDC');
    expect(remote.baseAmount).toContain('2.5');
  });

  it('shows the terminal-token amount paid for a buyback order', () => {
    const project = { chainId: 8453, tokenSymbol: 'ART', _flowToken: flowTokenFromContexts([[USDC_BASE]]) };
    const row = activityRowFromEvent(buybackEventOn(8453), project);
    expect(row.baseAmount).toBe('1.86 USDC');
    expect(row.tokenAmount).toBe('');
    expect(row.action).toBe('bought 4k ART via the buyback pool');
  });

  it('does not guess the buyback terminal token when accounting contexts are ambiguous', () => {
    const project = { chainId: 8453, tokenSymbol: 'ART', _flowToken: null };
    expect(activityRowFromEvent(buybackEventOn(8453), project).baseAmount).toBe('');
  });
});
