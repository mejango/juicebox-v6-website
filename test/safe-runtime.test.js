import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult } from 'viem';

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
  confirmSafeTx,
  executeSafeTx,
  getSafeNextNonce,
  listPendingSafeTxs,
  proposeSafeTx,
  SAFE_EXEC_ABI,
  safeApprovalsOf,
  SAFE_EXECUTION_SUCCESS_TOPIC,
  safeExecRelayrTx,
  safeHomeLink,
  safeOnChainContext,
  safeQueueLink,
  safeServiceChainIds,
  safeTxLink,
  safeTxHashForQueuedTx,
} from '../src/safe.js';
import { isTestnetChain } from '../src/chain.js';

const SAFE = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const TARGET = '0x4444444444444444444444444444444444444444';
const HASH = `0x${'ab'.repeat(32)}`;
const SIGNATURE = `0x${'12'.repeat(65)}`;
const SAFE_VIEW_ABI = [
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'approvedHashes', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
];

function rawSafeViews(resolver) {
  return vi.fn(({ method, params }) => {
    if (method !== 'eth_call') return Promise.reject(new Error('unexpected method'));
    var decoded = decodeFunctionData({ abi: SAFE_VIEW_ABI, data: params[0].data });
    return Promise.resolve(resolver(decoded.functionName, decoded.args || [])).then(function (result) {
      return encodeFunctionResult({ abi: SAFE_VIEW_ABI, functionName: decoded.functionName, result: result });
    });
  });
}

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

  it('probes every serviced chain for a Safe creation record, testnets first', () => {
    const ids = safeServiceChainIds();
    // The hand-written literal this replaced omitted Base Sepolia, so a testnet-only Safe could never be
    // redeployed same-address. Chains without a hosted service must still stay out.
    expect(ids).toContain(84532);
    expect(ids).toContain(11155111);
    expect(ids).toEqual(expect.arrayContaining([1, 10, 8453, 42161]));
    expect(ids).not.toContain(421614);
    expect(ids).not.toContain(11155420);
    const firstMainnet = ids.findIndex(id => !isTestnetChain(id));
    expect(ids.slice(0, firstMainnet).every(isTestnetChain)).toBe(true);
    expect(ids.slice(firstMainnet).some(isTestnetChain)).toBe(false);
  });

  it('picks up a localStorage tx-service override as a probe candidate', () => {
    localStorage.setItem('jb-safe-tx-base', JSON.stringify({ 421614: 'https://example.invalid/tx' }));
    expect(safeServiceChainIds()).toContain(421614);
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

  it('never serializes a service null confirmation without a proven approvedHashes marker', () => {
    const unproven = safeExecRelayrTx(1, SAFE, queuedTx({ confirmations: [{ owner: OWNER, signature: null }] }));
    const proven = safeExecRelayrTx(1, SAFE, queuedTx({ confirmations: [{ owner: OWNER, signature: null, approvedHash: true }] }));
    const unprovenArgs = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: unproven.data }).args;
    const provenArgs = decodeFunctionData({ abi: SAFE_EXEC_ABI, data: proven.data }).args;
    const prevalidated = '0x' + OWNER.slice(2).padStart(64, '0') + '0'.repeat(64) + '01';
    expect(unprovenArgs[9]).toBe('0x');
    expect(provenArgs[9].toLowerCase()).toBe(prevalidated.toLowerCase());
  });

  it('falls back from an unavailable nonce service to canonical on-chain state', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('service offline'));
    safeState.publicClient = { request: rawSafeViews(function () { return 9n; }) };

    await expect(getSafeNextNonce(1, SAFE)).resolves.toBe(9);
    expect(safeState.publicClient.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_call', params: [expect.objectContaining({ to: SAFE, gas: '0x493e0' }), 'latest'],
    }));

    safeState.publicClient.request.mockRejectedValue(new Error('RPC offline'));
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

  it('reads on-chain owners/threshold and rejects when any approval read fails', async () => {
    const reads = rawSafeViews((functionName, args) => {
      if (functionName === 'nonce') return Promise.resolve(7n);
      if (functionName === 'getThreshold') return Promise.resolve(2n);
      if (functionName === 'getOwners') return Promise.resolve([OWNER, OTHER]);
      if (functionName === 'approvedHashes' && args[0] === OWNER) return Promise.resolve(1n);
      return Promise.reject(new Error('unknown owner/read failure'));
    });
    safeState.publicClient = { request: reads };

    await expect(safeOnChainContext(421614, SAFE)).resolves.toEqual({
      nonce: 7,
      threshold: 2,
      owners: [OWNER, OTHER],
    });
    await expect(safeApprovalsOf(421614, SAFE, HASH, [OWNER, OTHER]))
      .rejects.toThrow(/unknown owner\/read failure/i);
    var approvalCall = reads.mock.calls.map(function (call) {
      return decodeFunctionData({ abi: SAFE_VIEW_ABI, data: call[0].params[0].data });
    }).find(function (decoded) { return decoded.functionName === 'approvedHashes'; });
    expect(approvalCall.args).toEqual([OWNER, HASH]);
  });

  it('refuses account changes and false/reverted simulations before reporting execution success', async () => {
    const writeContract = vi.fn().mockResolvedValue(HASH);
    safeState.wallet = { getChainId: vi.fn().mockResolvedValue(1), writeContract };
    const encodedExecResult = result => encodeFunctionResult({
      abi: SAFE_EXEC_ABI,
      functionName: 'execTransaction',
      result,
    });
    safeState.publicClient = {
      request: vi.fn().mockImplementation(async () => {
        safeState.account = OTHER;
        return encodedExecResult(true);
      }),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1n }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    };
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/account changed/i);
    expect(writeContract).not.toHaveBeenCalled();

    safeState.account = OWNER;
    safeState.publicClient.request.mockResolvedValue(encodedExecResult(false));
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/simulation reported.*fail/i);
    expect(writeContract).not.toHaveBeenCalled();

    safeState.publicClient.request.mockResolvedValue(encodedExecResult(true));
    safeState.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/reverted onchain/i);

    safeState.publicClient.waitForTransactionReceipt.mockRejectedValue(new Error('receipt RPC unavailable'));
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toMatchObject({
      code: 'SAFE_TX_SUBMITTED', hash: HASH,
    });

    safeState.publicClient.waitForTransactionReceipt.mockResolvedValue({ status: 'success', transactionHash: HASH, logs: [] });
    await expect(executeSafeTx(1, SAFE, queuedTx())).rejects.toThrow(/without ExecutionSuccess/i);

    const expectedSafeTxHash = safeTxHashForQueuedTx(1, SAFE, queuedTx());
    safeState.publicClient.waitForTransactionReceipt.mockResolvedValue({
      status: 'success', transactionHash: HASH,
      logs: [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS_TOPIC, expectedSafeTxHash], data: `0x${'0'.repeat(64)}` }],
    });
    await expect(executeSafeTx(1, SAFE, queuedTx())).resolves.toBe(HASH);
    expect(safeState.publicClient.request).toHaveBeenLastCalledWith({
      method: 'eth_call',
      params: [expect.objectContaining({ from: OWNER, to: SAFE, gas: '0x4c4b40' }), 'latest'],
    });
    expect(writeContract).toHaveBeenLastCalledWith(expect.objectContaining({
      account: OWNER,
      gas: 5000000n,
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

  it('reverifies proposal and confirmation authority after signing but before service writes', async () => {
    safeState.wallet = {
      getChainId: vi.fn().mockResolvedValue(1),
      signTypedData: vi.fn().mockResolvedValue(SIGNATURE),
    };
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 201 });
    const proposalReverify = vi.fn().mockRejectedValue(new Error('proposal policy changed'));

    await expect(proposeSafeTx({
      chainId: 1,
      safe: SAFE,
      to: TARGET,
      data: '0x1234',
      signer: OWNER,
      nonce: 13,
      reverify: proposalReverify,
    })).rejects.toThrow(/proposal policy changed/i);
    expect(safeState.wallet.signTypedData).toHaveBeenCalledOnce();
    expect(proposalReverify).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();

    safeState.wallet.signTypedData.mockClear();
    const confirmationReverify = vi.fn().mockRejectedValue(new Error('confirmation policy changed'));
    await expect(confirmSafeTx(1, SAFE, queuedTx({ safeTxHash: HASH }), OWNER, confirmationReverify))
      .rejects.toThrow(/confirmation policy changed/i);
    expect(safeState.wallet.signTypedData).toHaveBeenCalledOnce();
    expect(confirmationReverify).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
});
