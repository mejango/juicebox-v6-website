import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionResult } from 'viem';
import {
  bindRelayrSafeExecutions,
  clearRelayrPendingSession,
  loadRelayrPendingSession,
  relayrErrorIsUncertain,
  relayrPostBundle,
  relayrPoll,
  relayrProgress,
  relayrRequestFingerprint,
  relayrBoundStatusRecords,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
  verifyRelayrDestinationRecords,
} from '../src/relayr.js';
import { shouldUseRelayrForChains } from '../src/discover.js';
import { SAFE_EXECUTION_SUCCESS_TOPIC, safeExecRelayrTx, safeTxHashForQueuedTx } from '../src/safe.js';

const RELAY_TARGET = '0x1111111111111111111111111111111111111111';
const SAFE = '0x2222222222222222222222222222222222222222';
const INNER_TARGET = '0x3333333333333333333333333333333333333333';
function relayrRequest(index) {
  return { chain: 1, target: RELAY_TARGET, data: '0x', value: '0', virtual_nonce: index };
}
function relayrTxUuid(index) {
  return '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
}
function relayrExpected(count) {
  return Array.from({ length: count }, (_, index) => ({
    txUuid: relayrTxUuid(index), requestHash: relayrRequestFingerprint(relayrRequest(index)), chain: 1,
  }));
}
function boundRecords(transactions) {
  return transactions.map((record, index) => ({ ...record, tx_uuid: relayrTxUuid(index), request: relayrRequest(index) }));
}
function relayrResponse(bundleUuid, transactions, extras = {}) {
  return { ok: true, json: async () => ({ bundle_uuid: bundleUuid, payment_received: true, transactions, ...extras }) };
}

describe('Relayr execution state', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('treats both Relayr success states as confirmed and keeps the expected denominator', () => {
    expect(relayrStateIsSuccess('Success')).toBe(true);
    expect(relayrStateIsSuccess('Completed')).toBe(true);
    expect(relayrStateIsSuccess('Pending')).toBe(false);
    expect(relayrProgress([], 1)).toEqual({ confirmed: 0, failed: 0, pending: 1, total: 1, allFailed: false });
    expect(relayrProgress([
      { status: { state: 'Completed' } },
      { status: { state: 'Failed' } },
    ], 2)).toEqual({ confirmed: 1, failed: 1, pending: 0, total: 2, allFailed: false });
    // allFailed is the receipt auto-discard rule: only when every expected chain terminally failed.
    expect(relayrProgress([
      { status: { state: 'Failed' } },
      { status: { state: 'Failed' } },
    ], 2).allFailed).toBe(true);
    expect(relayrProgress([{ status: { state: 'Failed' } }], 2).allFailed).toBe(false);
  });

  it('resolves when Relayr reports Completed', async () => {
    const bundle = 'bundle-complete';
    const records = boundRecords([{ status: { state: 'Completed', data: { hash: `0x${'ab'.repeat(32)}` } } }]);
    const update = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(bundle, records)));

    await expect(relayrPoll(bundle, update, 10, 100, 1, relayrExpected(1))).resolves.toEqual(records);
    expect(update).toHaveBeenCalledWith(records, expect.objectContaining({ transactions: records }));
  });

  it('keeps polling when a successful response contains fewer records than expected', async () => {
    vi.useFakeTimers();
    const bundle = 'bundle-partial';
    const complete = boundRecords([
      { status: { state: 'Success', data: { hash: `0x${'01'.repeat(32)}` } } },
      { status: { state: 'Completed', data: { hash: `0x${'02'.repeat(32)}` } } },
    ]);
    const partial = [complete[0]];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(relayrResponse(bundle, partial))
      .mockResolvedValueOnce(relayrResponse(bundle, complete));
    vi.stubGlobal('fetch', fetchMock);

    var settled = false;
    const polling = relayrPoll(bundle, null, 10, 100, 2, relayrExpected(2)).then(function (records) {
      settled = true;
      return records;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(polling).resolves.toEqual(complete);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns structured terminal failure state without suggesting an automatic retry', async () => {
    const bundle = 'bundle-failed';
    const records = boundRecords([{ status: { state: 'Failed' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(bundle, records)));

    await expect(relayrPoll(bundle, null, 10, 100, 1, relayrExpected(1))).rejects.toMatchObject({
      name: 'RelayrExecutionError',
      code: 'RELAYR_FAILED',
      bundleUuid: 'bundle-failed',
      records,
      retryable: false,
    });
  });

  it('stops calling an expired, unrecognized payment pending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-26T21:00:00Z'));
    const bundle = 'bundle-expired';
    const records = boundRecords([{ status: { state: 'Pending' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bundle_uuid: bundle,
        payment_received: false,
        expires_at: '2026-07-26T20:53:52Z',
        transactions: records,
      }),
    })));

    await expect(relayrPoll(bundle, null, 10, 100, 1, relayrExpected(1))).rejects.toMatchObject({
      name: 'RelayrExecutionError',
      code: 'RELAYR_PAYMENT_EXPIRED',
      bundleUuid: 'bundle-expired',
      records,
      retryable: false,
    });
  });

  it('preserves the last known records when a paid bundle times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    const bundle = 'bundle-pending';
    const records = boundRecords([{ status: { state: 'Pending' } }]);
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(bundle, records)));

    const polling = relayrPoll(bundle, null, 10, 25, 1, relayrExpected(1));
    const rejected = expect(polling).rejects.toMatchObject({
      name: 'RelayrExecutionError',
      code: 'RELAYR_TIMEOUT',
      bundleUuid: 'bundle-pending',
      records,
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(40);
    await rejected;
    await expect(polling.catch((error) => relayrErrorIsUncertain(error))).resolves.toBe(true);
  });

  it('reports a bundle Relayr never had as a terminal not-found, not a retryable timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    // The whole point: this must NOT burn the full window and then tell the user to keep waiting.
    const polling = relayrPoll('bundle-unknown', null, 10, 5 * 60 * 1000, 1, relayrExpected(1));
    const rejected = expect(polling).rejects.toMatchObject({
      name: 'RelayrExecutionError',
      code: 'RELAYR_NOT_FOUND',
      bundleUuid: 'bundle-unknown',
      retryable: false,
    });
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await expect(polling.catch((error) => relayrErrorIsUncertain(error))).resolves.toBe(false);
  });

  it('tolerates a brief 404 blip and keeps polling the same bundle', async () => {
    vi.useFakeTimers();
    const bundle = 'bundle-blip';
    const records = boundRecords([{ status: { state: 'Success', data: { hash: `0x${'03'.repeat(32)}` } } }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(relayrResponse(bundle, records));
    vi.stubGlobal('fetch', fetchMock);

    const polling = relayrPoll(bundle, null, 10, 100, 1, relayrExpected(1));
    await vi.advanceTimersByTimeAsync(30);
    await expect(polling).resolves.toEqual(records);
  });

  it('automatically retries transient Relayr status errors against the same bundle', async () => {
    vi.useFakeTimers();
    const bundle = 'bundle-recovering';
    const records = boundRecords([{ status: { state: 'Success', data: { hash: `0x${'04'.repeat(32)}` } } }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(relayrResponse(bundle, records));
    vi.stubGlobal('fetch', fetchMock);

    const polling = relayrPoll(bundle, null, 10, 100, 1, relayrExpected(1));
    await vi.advanceTimersByTimeAsync(10);
    await expect(polling).resolves.toEqual(records);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung status request instead of leaving the UI pending forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const polling = relayrPoll('bundle-hung', null, 10, 25, 1, relayrExpected(1));
    const rejected = expect(polling).rejects.toMatchObject({
      code: 'RELAYR_TIMEOUT',
      bundleUuid: 'bundle-hung',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
  });

  it('bounds a hung quote request and clearly marks it safe to retry before payment', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const quoting = relayrPostBundle([{ chain: 84532, target: '0xtarget', data: '0x', value: '0' }]);
    const rejected = expect(quoting).rejects.toMatchObject({
      code: 'RELAYR_QUOTE_TIMEOUT',
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(45_000);
    await rejected;
  });

  it.each(['tx_uuids', 'txn_uuids'])('binds every quoted request to Relayr’s %s response IDs', async (field) => {
    const bundleUuid = '01234567-89ab-cdef-0123-456789abcdef';
    const txUuid = relayrTxUuid(0);
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ bundle_uuid: bundleUuid, [field]: [txUuid], payment_info: [] }),
    })));
    const request = { chain: 1, target: RELAY_TARGET, data: '0x1234', value: '0' };
    const quote = await relayrPostBundle([request]);
    expect(quote.expected_transactions).toEqual([{
      txUuid, chain: 1,
      requestHash: relayrRequestFingerprint({ ...request, virtual_nonce: 0 }),
    }]);
  });
});

describe('Relayr routing boundary', () => {
  it('reserves Relayr for genuine multichain operations', () => {
    expect(shouldUseRelayrForChains([])).toBe(false);
    expect(shouldUseRelayrForChains([{ id: 8453 }])).toBe(false);
    expect(shouldUseRelayrForChains([{ id: 8453 }, { id: 8453 }])).toBe(false);
    expect(shouldUseRelayrForChains([{ id: 8453 }, { id: 10 }])).toBe(true);
  });
});

describe('Relayr pending receipt storage', () => {
  afterEach(() => { localStorage.clear(); });

  it('stores only the receipt needed to resume the same bundle', () => {
    const saved = saveRelayrPendingSession('shop-add-items:84532:11', {
      bundleUuid: 'bundle-123',
      paymentHash: '0xpayment',
      paymentChainId: 84532,
      expectedCount: 1,
      chains: [{ id: 84532, name: 'Base Sepolia' }],
      records: [{ status: { state: 'Pending', data: { transaction: { hash: '0xdestination' } } } }],
      itemCount: 2,
      account: '0xoperator',
      createdAt: 123,
      signature: 'must-not-be-stored',
      calldata: 'must-not-be-stored',
    });

    expect(saved).toMatchObject({ bundleUuid: 'bundle-123', expectedCount: 1, itemCount: 2 });
    expect(loadRelayrPendingSession('shop-add-items:84532:11')).toEqual(saved);
    const raw = localStorage.getItem('jb-relayr-pending-v1:shop-add-items:84532:11');
    expect(raw).not.toContain('must-not-be-stored');
    expect(raw).toContain('0xdestination');

    clearRelayrPendingSession('shop-add-items:84532:11');
    expect(loadRelayrPendingSession('shop-add-items:84532:11')).toBeNull();
  });

  it('round-trips only the bounded Safe execution proof needed after reload', () => {
    const expected = bindRelayrSafeExecutions(relayrExpected(1), [{
      chain: 1, safe: SAFE, nonce: 7, safeTxHash: `0x${'aa'.repeat(32)}`,
      signature: 'must-not-be-stored', calldata: 'must-not-be-stored',
    }]);
    const saved = saveRelayrPendingSession('safe-queue:' + SAFE, {
      bundleUuid: 'bundle-safe', expectedCount: 1, expectedTransactions: expected,
      chains: [{ id: 1, name: 'Ethereum' }], records: [],
    });
    expect(saved.expectedTransactions[0].result).toEqual({
      kind: 'safe-exec', safe: SAFE, nonce: '7', safeTxHash: `0x${'aa'.repeat(32)}`,
    });
    const raw = localStorage.getItem('jb-relayr-pending-v1:safe-queue:' + SAFE);
    expect(raw).not.toContain('must-not-be-stored');
    expect(loadRelayrPendingSession('safe-queue:' + SAFE).expectedTransactions).toEqual(saved.expectedTransactions);
  });

  it('keeps unrelated Relayr actions in separate durable scopes', () => {
    saveRelayrPendingSession('edit-project:1', { bundleUuid: 'bundle-a', expectedCount: 1 });
    saveRelayrPendingSession('queue-ruleset:1', { bundleUuid: 'bundle-b', expectedCount: 2 });

    expect(loadRelayrPendingSession('edit-project:1').bundleUuid).toBe('bundle-a');
    expect(loadRelayrPendingSession('queue-ruleset:1').bundleUuid).toBe('bundle-b');
  });
});

describe('Relayr exact result binding', () => {
  it('rejects wrong bundle IDs, duplicate UUIDs, and changed echoed requests', () => {
    const expected = relayrExpected(2);
    const records = boundRecords([{ status: { state: 'Pending' } }, { status: { state: 'Pending' } }]);
    expect(() => relayrBoundStatusRecords('bundle-a', { bundle_uuid: 'bundle-b', transactions: records }, expected))
      .toThrow(/bundle ID/i);
    expect(() => relayrBoundStatusRecords('bundle-a', {
      bundle_uuid: 'bundle-a', transactions: [records[0], { ...records[1], tx_uuid: records[0].tx_uuid }],
    }, expected)).toThrow(/duplicate or unsubmitted/i);
    expect(() => relayrBoundStatusRecords('bundle-a', {
      bundle_uuid: 'bundle-a', transactions: [{ ...records[0], request: { ...records[0].request, data: '0x12' } }],
    }, expected)).toThrow(/fields do not match/i);
  });

  it('proves exact destination calldata and both canonical Safe ExecutionSuccess layouts', async () => {
    const tx = {
      to: INNER_TARGET, value: 0, data: '0x1234', operation: 0, nonce: 7,
      safeTxGas: 0, baseGas: 0, gasPrice: 0,
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      confirmations: [{ owner: '0x4444444444444444444444444444444444444444', signature: `0x${'11'.repeat(65)}` }],
    };
    const call = safeExecRelayrTx(1, SAFE, tx);
    const request = { ...call, virtual_nonce: 0 };
    const safeTxHash = safeTxHashForQueuedTx(1, SAFE, tx);
    const expected = bindRelayrSafeExecutions([{
      txUuid: relayrTxUuid(0), requestHash: relayrRequestFingerprint(request), chain: 1,
    }], [{ chain: 1, safe: SAFE, nonce: tx.nonce, safeTxHash }]);
    const destinationHash = `0x${'cd'.repeat(32)}`;
    const record = { tx_uuid: relayrTxUuid(0), request, status: { state: 'Success', data: { hash: destinationHash } } };
    const nonceResult = encodeFunctionResult({
      abi: [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'nonce', result: 8n,
    });
    const client = {
      getTransaction: vi.fn().mockResolvedValue({ to: SAFE, input: call.data, value: 0n }),
      getTransactionReceipt: vi.fn(),
      request: vi.fn().mockResolvedValue(nonceResult),
    };
    client.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: destinationHash,
      logs: [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS_TOPIC, safeTxHash], data: `0x${'0'.repeat(64)}` }],
    });
    await expect(verifyRelayrDestinationRecords(expected, [record], () => client)).resolves.toBe(true);

    client.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: destinationHash,
      logs: [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS_TOPIC], data: safeTxHash + '0'.repeat(64) }],
    });
    await expect(verifyRelayrDestinationRecords(expected, [record], () => client)).resolves.toBe(true);

    client.getTransactionReceipt.mockResolvedValueOnce({ status: 'success', transactionHash: destinationHash, logs: [] });
    await expect(verifyRelayrDestinationRecords(expected, [record], () => client)).rejects.toThrow(/ExecutionSuccess/i);
    client.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: destinationHash,
      logs: [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS_TOPIC, safeTxHash], data: `0x${'0'.repeat(63)}1` }],
    });
    await expect(verifyRelayrDestinationRecords(expected, [record], () => client)).rejects.toThrow(/ExecutionSuccess/i);

    client.getTransactionReceipt.mockResolvedValueOnce({
      status: 'success', transactionHash: destinationHash,
      logs: [{ address: SAFE, topics: [SAFE_EXECUTION_SUCCESS_TOPIC, safeTxHash], data: `0x${'0'.repeat(64)}` }],
    });
    client.request.mockResolvedValueOnce(encodeFunctionResult({
      abi: [{ type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }],
      functionName: 'nonce', result: 7n,
    }));
    await expect(verifyRelayrDestinationRecords(expected, [record], () => client)).rejects.toThrow(/nonce did not advance/i);
  });
});
