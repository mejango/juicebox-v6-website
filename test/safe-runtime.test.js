import { beforeEach, describe, expect, it, vi } from 'vitest';

const safeState = vi.hoisted(() => ({
  account: null,
  publicClient: null,
  switchChain: vi.fn(),
  wallet: null,
}));

vi.mock('../src/component-base.js', () => ({
  getWalletClient: () => safeState.wallet,
  getAccount: () => safeState.account,
  getViewAs: () => null,
  VIEW_AS_TX_ERROR: "You're viewing the site as another account — exit View as to transact.",
  switchChain: safeState.switchChain,
  createPublicClientForChain: () => safeState.publicClient,
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
}));

import {
  executeSafeTx,
  getSafeNextNonce,
  listPendingSafeTxs,
  proposeSafeTx,
  safeApprovalsOf,
  safeExecRelayrTx,
  safeHomeLink,
  safeOnChainContext,
  safeQueueLink,
  safeTxLink,
} from '../src/safe.js';

const SAFE = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const TARGET = '0x4444444444444444444444444444444444444444';
const HASH = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'12'.repeat(65)}`;

function queuedTx(overrides = {}) {
  return {
    to: TARGET,
    value: '0',
    data: '0x1234',
    operation: 0,
    nonce: 5,
    confirmations: [{ owner: OWNER, signature: SIGNATURE }],
    ...overrides,
  };
}

describe('Safe runtime fail-closed boundaries', () => {
  beforeEach(() => {
    localStorage.clear();
    safeState.account = OWNER;
    safeState.publicClient = null;
    safeState.wallet = null;
    safeState.switchChain.mockReset();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uses explicit supported links and returns terminal nulls for unknown service chains', () => {
    expect(safeQueueLink(1, SAFE)).toContain(`safe=eth:${SAFE}`);
    expect(safeTxLink(8453, SAFE, HASH)).toContain(`multisig_${SAFE}_${HASH}`);
    expect(safeQueueLink(421614, SAFE)).toBeNull();
    expect(safeTxLink(421614, SAFE, HASH)).toBeNull();
    expect(safeHomeLink(421614, SAFE)).toContain(`safe=eth:${SAFE}`);
    expect(safeExecRelayrTx(421614, SAFE, queuedTx())).toMatchObject({
      chain: 421614,
      target: SAFE,
      value: '0',
      data: expect.stringMatching(/^0x/),
    });
  });

  it('falls back from an unavailable nonce service to canonical on-chain state', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('service offline'));
    safeState.publicClient = { readContract: vi.fn().mockResolvedValue(9n) };

    await expect(getSafeNextNonce(1, SAFE)).resolves.toBe(9);
    expect(safeState.publicClient.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: SAFE,
      functionName: 'nonce',
      args: [],
    }));

    safeState.publicClient.readContract.mockRejectedValue(new Error('RPC offline'));
    await expect(getSafeNextNonce(1, OTHER)).resolves.toBeNull();
  });

  it('filters dead queue nonces and terminates unsupported chains with an empty queue', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ nonce: 5 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ nonce: 4 }, { nonce: 5 }, { nonce: 6 }] }),
      });
    safeState.publicClient = { readContract: vi.fn() };

    await expect(listPendingSafeTxs(1, SAFE)).resolves.toEqual([{ nonce: 5 }, { nonce: 6 }]);
    expect(vi.mocked(fetch).mock.calls[1][0]).toContain('nonce__gte=5');
    await expect(listPendingSafeTxs(421614, SAFE)).resolves.toEqual([]);
  });

  it('reads on-chain owners/threshold and treats failed approval reads as unapproved', async () => {
    const reads = vi.fn(({ functionName, args }) => {
      if (functionName === 'nonce') return Promise.resolve(7n);
      if (functionName === 'getThreshold') return Promise.resolve(2n);
      if (functionName === 'getOwners') return Promise.resolve([OWNER, OTHER]);
      if (functionName === 'approvedHashes' && args[0] === OWNER) return Promise.resolve(1n);
      return Promise.reject(new Error('unknown owner/read failure'));
    });
    safeState.publicClient = { readContract: reads };

    await expect(safeOnChainContext(421614, SAFE)).resolves.toEqual({
      nonce: 7,
      threshold: 2,
      owners: [OWNER, OTHER],
    });
    await expect(safeApprovalsOf(421614, SAFE, HASH, [OWNER, OTHER])).resolves.toEqual([OWNER]);
  });

  it('refuses account changes and false/reverted simulations before reporting execution success', async () => {
    const writeContract = vi.fn().mockResolvedValue(HASH);
    safeState.wallet = { getChainId: vi.fn().mockResolvedValue(1), writeContract };
    safeState.publicClient = {
      simulateContract: vi.fn().mockImplementation(async () => {
        safeState.account = OTHER;
        return { result: true, request: { address: SAFE } };
      }),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/account changed/i);
    expect(writeContract).not.toHaveBeenCalled();

    safeState.account = OWNER;
    safeState.publicClient.simulateContract.mockResolvedValue({ result: false, request: { address: SAFE } });
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/simulation reported.*fail/i);
    expect(writeContract).not.toHaveBeenCalled();

    safeState.publicClient.simulateContract.mockResolvedValue({ result: true, request: { address: SAFE } });
    safeState.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/reverted onchain/i);

    safeState.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success' });
    await expect(executeSafeTx(1, SAFE, queuedTx())).resolves.toBe(HASH);
    expect(writeContract).toHaveBeenLastCalledWith(expect.objectContaining({
      account: OWNER,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 50000000n,
    }));
  });

  it('binds a proposal to the reviewed signer, chain, nonce, and exact service payload', async () => {
    safeState.wallet = {
      getChainId: vi.fn().mockResolvedValue(1),
      signTypedData: vi.fn().mockResolvedValue(SIGNATURE),
    };
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 201 });

    const proposal = await proposeSafeTx({
      chainId: 1,
      safe: SAFE,
      to: TARGET,
      data: '0x1234',
      value: 3n,
      signer: OWNER,
      nonce: 11,
    });
    expect(proposal).toMatchObject({ nonce: 11, signature: SIGNATURE });
    expect(safeState.wallet.signTypedData).toHaveBeenCalledWith(expect.objectContaining({
      account: OWNER,
      domain: { chainId: 1, verifyingContract: SAFE },
      primaryType: 'SafeTx',
    }));
    const request = vi.mocked(fetch).mock.calls[0];
    expect(request[0]).toContain('/multisig-transactions/');
    expect(JSON.parse(request[1].body)).toMatchObject({
      to: TARGET,
      value: '3',
      nonce: '11',
      sender: OWNER,
      signature: SIGNATURE,
    });

    safeState.wallet.signTypedData.mockImplementation(async () => {
      safeState.account = OTHER;
      return SIGNATURE;
    });
    await expect(proposeSafeTx({
      chainId: 1, safe: SAFE, to: TARGET, data: '0x', signer: OWNER, nonce: 12,
    })).rejects.toThrow(/account changed/i);
  });
});
