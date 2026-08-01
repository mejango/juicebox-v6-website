// Cross-component money/address helpers: every pay/cashout/mint/burn/payout component routes amounts
// through parseAmount/formatAmount and recipients through addrOrZero/isAddr. A bug here mis-scales a
// transaction amount (wrong decimals) or mis-routes funds, so they get their own guard.
import { describe, it, expect } from 'vitest';
import { parseAmount, formatAmount } from '../src/encoding.js';
import { isAddr, addrOrZero, friendlyTransactionError, shouldKeepSubmittedTransactionPending, waitForErc20Approval, waitForTrackedTransactionReceipt, ZERO_ADDRESS } from '../src/component-base.js';
import { parseEther, parseUnits } from 'viem';

const GOOD = '0x1111111111111111111111111111111111111111';

describe('parseAmount / formatAmount — decimals-correct amount scaling', () => {
  it('18-dec parses like parseEther and round-trips', () => {
    expect(parseAmount('1.5', 18)).toBe(parseEther('1.5'));
    expect(formatAmount(parseAmount('1.5', 18), 18)).toBe('1.5');
  });
  it('6-dec (USDC) parses like parseUnits(…,6) — 1.5 → 1500000, not 1.5e18', () => {
    expect(parseAmount('1.5', 6)).toBe(parseUnits('1.5', 6));
    expect(parseAmount('1.5', 6)).toBe(1500000n);
    expect(formatAmount(1500000n, 6)).toBe('1.5');
  });
  it('round-trips an exact integer at 6 and 18 decimals', () => {
    for (const d of [6, 18]) expect(formatAmount(parseAmount('1000', d), d)).toBe('1000');
  });
});

describe('addrOrZero / isAddr — recipient safety coercion', () => {
  it('a valid address passes through', () => {
    expect(isAddr(GOOD)).toBe(true);
    expect(addrOrZero(GOOD)).toBe(GOOD);
  });
  it('blank / garbage / non-string coerces to the zero address (never garbage on-chain)', () => {
    for (const bad of ['', '0x', '0xnothex', 'vitalik.eth', null, undefined, 123]) {
      expect(isAddr(bad)).toBe(false);
      expect(addrOrZero(bad)).toBe(ZERO_ADDRESS);
    }
  });
  it('accepts a non-checksummed address (strict:false) so user paste isn’t rejected', () => {
    expect(isAddr(GOOD.toLowerCase())).toBe(true);
  });
});

describe('raw transaction error messages', () => {
  it('turns expired Permit2 and under-min selectors into useful recovery steps', () => {
    expect(friendlyTransactionError('reverted with signature: 0xd81b2f2e')).toMatch(/authorization expired.*try again/i);
    expect(friendlyTransactionError('0x6b2bb382')).toMatch(/below the minimum.*refresh/i);
    expect(friendlyTransactionError('reverted with signature: 0x30116425')).toMatch(/deployment failed.*reactivate archived shop/i);
    expect(friendlyTransactionError('reverted with signature: 0x76d03816')).toMatch(/no price feed.*supported currency/i);
    expect(friendlyTransactionError('reverted with signature: 0xee890b46')).toMatch(/worth less.*item total/i);
    expect(friendlyTransactionError('0xdeadbeef')).toBeNull();
  });

  it('keeps a wallet-broadcast transaction pending when only receipt tracking fails', () => {
    expect(shouldKeepSubmittedTransactionPending('0xhash', new Error('Invalid RPC parameters'))).toBe(true);
    expect(shouldKeepSubmittedTransactionPending(null, new Error('Invalid RPC parameters'))).toBe(false);
    const reverted = new Error('reverted');
    reverted.onchainRevert = true;
    expect(shouldKeepSubmittedTransactionPending('0xhash', reverted)).toBe(false);
  });
});

describe('ERC-20 approval finality', () => {
  it('verifies the receipt and allowance at the exact approval block', async () => {
    const calls = [];
    const client = {
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 123n }),
      readContract: async (request) => { calls.push(request); return 50n; },
    };
    await expect(waitForErc20Approval(client, '0xhash', GOOD, GOOD, GOOD, 50n)).resolves.toMatchObject({ blockNumber: 123n });
    expect(calls[0].blockNumber).toBe(123n);
  });

  it('blocks the follow-on transaction when approval reverted or granted too little', async () => {
    const reverted = { waitForTransactionReceipt: async () => ({ status: 'reverted', blockNumber: 1n }) };
    await expect(waitForErc20Approval(reverted, '0xhash', GOOD, GOOD, GOOD, 1n)).rejects.toThrow(/reverted onchain/i);
    const short = {
      waitForTransactionReceipt: async () => ({ status: 'success', blockNumber: 2n }),
      readContract: async () => 9n,
    };
    await expect(waitForErc20Approval(short, '0xhash', GOOD, GOOD, GOOD, 10n)).rejects.toThrow(/did not grant/i);
  });
});

describe('transaction receipt tracking', () => {
  it('uses a direct mined-receipt lookup instead of waiting on a stuck watcher', async () => {
    const receipt = { status: 'success', blockNumber: 456n, transactionHash: '0xhash' };
    const client = {
      getTransactionReceipt: async () => receipt,
      waitForTransactionReceipt: () => new Promise(() => undefined),
    };

    await expect(waitForTrackedTransactionReceipt(client, '0xhash')).resolves.toBe(receipt);
  });
});
