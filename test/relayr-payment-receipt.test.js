import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256 } from 'viem';

const state = vi.hoisted(() => ({
  account: '0x1111111111111111111111111111111111111111',
  wallet: null,
  client: null,
  review: null,
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
  confirmTransactionModal: (...args) => state.review(...args),
}));

vi.mock('../src/chain.js', () => ({
  CHAINS: { 1: { id: 1, name: 'Ethereum' } },
  chainNameFor: id => (id === 1 ? 'Ethereum' : `chain ${id}`),
}));

import {
  RELAYR_NATIVE_TOKEN,
  RELAYR_PAYMENT_ADDRESS,
  RELAYR_PAYMENT_CODE_HASH,
  RELAYR_PAYMENT_SELECTOR,
  relayrPay,
  relayrPaymentDetails,
} from '../src/relayr.js';

const HASH = `0x${'ab'.repeat(32)}`;
const BUNDLE_UUID = '01234567-89ab-cdef-0123-456789abcdef';
const OTHER_UUID = 'fedcba98-7654-3210-fedc-ba9876543210';
const NOW = 2_000_000_000;
const DEADLINE = NOW + 3600;
// Canonical runtime at RELAYR_PAYMENT_ADDRESS. Its exact hash is pinned by relayr.js.
const PAYMENT_RUNTIME = '0x608060405260043610156010575f80fd5b5f3560e01c63103903a7146022575f80fd5b604036600319011260ef576004356fffffffffffffffffffffffffffffffff19811680910360ef5760243564ffffffffff811680910360ef5780421160ce575f341560c6575b5f8080809373755ff2f75a0a586ecfa2b9a3c959cb662458a1053491f11560bb5760407fb96b060a9c075a83da0cf1f9405deeb5df21df681a762de16c3d5eaf99531cd8918151903482526020820152a2005b6040513d5f823e3d90fd5b506108fc6068565b90630f01bd8760e21b5f5260045260245264ffffffffff421660445260645ffd5b5f80fdfea26469706673582212206ea0d2ba1e0cb26cc9293b24f1a7aecc1de7e328ca83d6b3bf5382ac44c7390064736f6c634300081a0033';

function paymentCalldata(uuid = BUNDLE_UUID, deadline = DEADLINE, selector = RELAYR_PAYMENT_SELECTOR) {
  var uuidWord = uuid.replace(/-/g, '').toLowerCase().padEnd(64, '0');
  var deadlineWord = BigInt(deadline).toString(16).padStart(64, '0');
  return selector + uuidWord + deadlineWord;
}

function paymentFor(overrides = {}) {
  var deadline = Object.prototype.hasOwnProperty.call(overrides, 'deadline') ? overrides.deadline : DEADLINE;
  return {
    chain: 1,
    target: RELAYR_PAYMENT_ADDRESS,
    token: RELAYR_NATIVE_TOKEN,
    amount: '1',
    calldata: paymentCalldata(BUNDLE_UUID, deadline),
    payment_deadline: String(deadline),
    ...overrides,
  };
}

describe('Relayr payment quote authentication', () => {
  it('accepts only the canonical payment target, selector, and native token', () => {
    expect(relayrPaymentDetails(paymentFor(), BUNDLE_UUID, NOW)).toMatchObject({
      chainId: 1,
      target: RELAYR_PAYMENT_ADDRESS,
      amount: 1n,
      bundleUuid: BUNDLE_UUID,
      deadline: BigInt(DEADLINE),
    });
    expect(() => relayrPaymentDetails(paymentFor({
      target: '0x2222222222222222222222222222222222222222',
    }), BUNDLE_UUID, NOW)).toThrow(/unrecognized payment contract/i);
    expect(() => relayrPaymentDetails(paymentFor({
      token: '0x0000000000000000000000000000000000000000',
    }), BUNDLE_UUID, NOW)).toThrow(/unsupported payment token/i);
    expect(() => relayrPaymentDetails(paymentFor({
      calldata: paymentCalldata(BUNDLE_UUID, DEADLINE, '0xdeadbeef'),
    }), BUNDLE_UUID, NOW)).toThrow(/unrecognized payment function/i);
  });

  it('binds calldata to the exact bundle UUID and quoted deadline', () => {
    expect(() => relayrPaymentDetails(paymentFor(), OTHER_UUID, NOW)).toThrow(/does not match this bundle/i);
    expect(() => relayrPaymentDetails(paymentFor({
      calldata: paymentCalldata(BUNDLE_UUID, DEADLINE + 1),
    }), BUNDLE_UUID, NOW)).toThrow(/does not match the quote deadline/i);
  });

  it('rejects a quote at or inside the payment-expiry safety window', () => {
    var expiring = paymentFor({ deadline: NOW + 15 });
    expect(() => relayrPaymentDetails(expiring, BUNDLE_UUID, NOW)).toThrow(/quote expired/i);
    expect(relayrPaymentDetails(paymentFor({ deadline: NOW + 16 }), BUNDLE_UUID, NOW).deadline)
      .toBe(BigInt(NOW + 16));
  });
});

describe('Relayr payment receipt tracking', () => {
  beforeEach(() => {
    state.account = '0x1111111111111111111111111111111111111111';
    state.review = vi.fn().mockResolvedValue(true);
    state.wallet = {
      getChainId: vi.fn().mockResolvedValue(1),
      sendTransaction: vi.fn().mockResolvedValue(HASH),
    };
    state.client = {
      request: vi.fn(async function ({ method }) {
        if (method === 'eth_getCode') return PAYMENT_RUNTIME;
        if (method === 'eth_call') return '0x';
        throw new Error('unexpected RPC method');
      }),
      call: vi.fn(),
      simulateContract: vi.fn(),
      track: vi.fn().mockResolvedValue({ status: 'success' }),
    };
  });

  it('requires exact runtime authentication, mandatory review, and a raw no-CCIP simulation', async () => {
    const submitted = vi.fn();
    await expect(relayrPay(paymentFor(), state.account, submitted, BUNDLE_UUID)).resolves.toBe(HASH);
    expect(keccak256(PAYMENT_RUNTIME)).toBe(RELAYR_PAYMENT_CODE_HASH);
    expect(state.review).toHaveBeenCalledOnce();
    expect(state.review).toHaveBeenCalledWith(expect.objectContaining({
      address: RELAYR_PAYMENT_ADDRESS,
      calldata: paymentCalldata(),
      value: 1n,
    }), expect.objectContaining({ title: 'Review Relayr payment' }));
    expect(state.client.request).toHaveBeenCalledWith({
      method: 'eth_getCode', params: [RELAYR_PAYMENT_ADDRESS, 'latest'],
    });
    expect(state.client.request).toHaveBeenCalledWith({
      method: 'eth_call',
      params: [{
        from: state.account,
        to: RELAYR_PAYMENT_ADDRESS,
        value: '0x1',
        data: paymentCalldata(),
        gas: '0x249f0',
      }, 'latest'],
    });
    expect(state.client.call).not.toHaveBeenCalled();
    expect(state.client.simulateContract).not.toHaveBeenCalled();
    expect(state.review.mock.invocationCallOrder[0]).toBeLessThan(state.wallet.sendTransaction.mock.invocationCallOrder[0]);
    expect(submitted).toHaveBeenCalledWith(HASH);
    expect(submitted.mock.invocationCallOrder[0]).toBeLessThan(state.client.track.mock.invocationCallOrder[0]);
  });

  it('rejects a different runtime before review or wallet submission', async () => {
    state.client.request.mockImplementation(async function ({ method }) {
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') return '0x';
      throw new Error('unexpected RPC method');
    });
    await expect(relayrPay(paymentFor(), state.account, null, BUNDLE_UUID))
      .rejects.toThrow(/contract code is not recognized/i);
    expect(state.review).not.toHaveBeenCalled();
    expect(state.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('never opens the wallet when the mandatory payment review is cancelled', async () => {
    state.review.mockResolvedValue(false);
    await expect(relayrPay(paymentFor(), state.account, null, BUNDLE_UUID)).rejects.toThrow(/cancelled/i);
    expect(state.review).toHaveBeenCalledOnce();
    expect(state.wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps a receipt RPC failure explicitly submitted and non-retryable', async () => {
    state.client.track.mockRejectedValue(new Error('Invalid RPC parameters'));
    const submitted = vi.fn();
    await expect(relayrPay(paymentFor(), state.account, submitted, BUNDLE_UUID)).rejects.toMatchObject({
      name: 'RelayrPaymentSubmittedError',
      code: 'RELAYR_PAYMENT_SUBMITTED',
      hash: HASH,
      chainId: 1,
    });
    expect(submitted).toHaveBeenCalledWith(HASH);
  });
});
