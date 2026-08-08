import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRelayrPendingSession,
  loadRelayrPendingSession,
  relayrErrorIsUncertain,
  relayrPostBundle,
  relayrPoll,
  relayrProgress,
  relayrStateIsSuccess,
  saveRelayrPendingSession,
} from '../src/relayr.js';
import { shouldUseRelayrForChains } from '../src/discover.js';

function relayrResponse(transactions) {
  return { ok: true, json: async () => ({ transactions }) };
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
    const records = [{ status: { state: 'Completed', data: { hash: '0xabc' } } }];
    const update = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(records)));

    await expect(relayrPoll('bundle-complete', update, 10, 100)).resolves.toEqual(records);
    expect(update).toHaveBeenCalledWith(records, { transactions: records });
  });

  it('returns structured terminal failure state without suggesting an automatic retry', async () => {
    const records = [{ status: { state: 'Failed' } }];
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(records)));

    await expect(relayrPoll('bundle-failed', null, 10, 100)).rejects.toMatchObject({
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
    const records = [{ status: { state: 'Pending' } }];
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        payment_received: false,
        expires_at: '2026-07-26T20:53:52Z',
        transactions: records,
      }),
    })));

    await expect(relayrPoll('bundle-expired', null, 10, 100)).rejects.toMatchObject({
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
    const records = [{ status: { state: 'Pending' } }];
    vi.stubGlobal('fetch', vi.fn(async () => relayrResponse(records)));

    const polling = relayrPoll('bundle-pending', null, 10, 25);
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
    const polling = relayrPoll('bundle-unknown', null, 10, 5 * 60 * 1000);
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
    const records = [{ status: { state: 'Success' } }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce(relayrResponse(records));
    vi.stubGlobal('fetch', fetchMock);

    const polling = relayrPoll('bundle-blip', null, 10, 100);
    await vi.advanceTimersByTimeAsync(30);
    await expect(polling).resolves.toEqual(records);
  });

  it('automatically retries transient Relayr status errors against the same bundle', async () => {
    vi.useFakeTimers();
    const records = [{ status: { state: 'Success' } }];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(relayrResponse(records));
    vi.stubGlobal('fetch', fetchMock);

    const polling = relayrPoll('bundle-recovering', null, 10, 100);
    await vi.advanceTimersByTimeAsync(10);
    await expect(polling).resolves.toEqual(records);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a hung status request instead of leaving the UI pending forever', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    const polling = relayrPoll('bundle-hung', null, 10, 25);
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

  it('keeps unrelated Relayr actions in separate durable scopes', () => {
    saveRelayrPendingSession('edit-project:1', { bundleUuid: 'bundle-a', expectedCount: 1 });
    saveRelayrPendingSession('queue-ruleset:1', { bundleUuid: 'bundle-b', expectedCount: 2 });

    expect(loadRelayrPendingSession('edit-project:1').bundleUuid).toBe('bundle-a');
    expect(loadRelayrPendingSession('queue-ruleset:1').bundleUuid).toBe('bundle-b');
  });
});
