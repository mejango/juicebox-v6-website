import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  wallet: null,
  client: null,
}));

vi.mock('../src/component-base.js', () => ({
  getWalletClient: () => state.wallet,
  getAccount: () => state.account,
  createPublicClientForChain: () => state.client,
  getAddress: () => '0x2222222222222222222222222222222222222222',
  switchChain: vi.fn(),
  getViewAs: () => null,
  VIEW_AS_TX_ERROR: 'View as is read-only.',
  waitForTrackedTransactionReceipt: (client, hash, wallet, chainId) => client.track(hash, wallet, chainId),
}));

vi.mock('../src/chain.js', () => ({
  CHAINS: { 1: { id: 1, name: 'Ethereum' } },
}));

import { relayrPay } from '../src/relayr.js';

const HASH = `0x${'ab'.repeat(32)}`;
const payment = {
  chain: 1,
  target: '0x2222222222222222222222222222222222222222',
  amount: '1',
  calldata: '0x',
};

describe('Relayr payment receipt tracking', () => {
  beforeEach(() => {
    state.wallet = {
      getChainId: vi.fn().mockResolvedValue(1),
      sendTransaction: vi.fn().mockResolvedValue(HASH),
    };
    state.client = {
      estimateGas: vi.fn().mockResolvedValue(21_000n),
      track: vi.fn().mockResolvedValue({ status: 'success' }),
    };
  });

  it('exposes the payment hash before waiting for its receipt', async () => {
    const submitted = vi.fn();
    await expect(relayrPay(payment, state.account, submitted)).resolves.toBe(HASH);
    expect(submitted).toHaveBeenCalledWith(HASH);
    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(state.client.track.mock.invocationCallOrder[0]);
  });

  it('keeps a receipt RPC failure explicitly submitted and non-retryable', async () => {
    state.client.track.mockRejectedValue(new Error('Invalid RPC parameters'));
    const submitted = vi.fn();
    await expect(relayrPay(payment, state.account, submitted)).rejects.toMatchObject({
      name: 'RelayrPaymentSubmittedError',
      code: 'RELAYR_PAYMENT_SUBMITTED',
      hash: HASH,
      chainId: 1,
    });
    expect(submitted).toHaveBeenCalledWith(HASH);
  });
});
