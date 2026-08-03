import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheDeserialize,
  cacheGet,
  cacheSerialize,
  cacheSet,
  cacheStale,
  cacheValidated,
} from '../src/cache.js';

describe('cross-session cache', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips bigints, which every onchain read returns', () => {
    const value = { weight: 10n ** 18n, nested: [{ id: 7n }] };
    const restored = cacheDeserialize(cacheSerialize(value));
    expect(restored.weight).toBe(10n ** 18n);
    expect(restored.nested[0].id).toBe(7n);
    expect(typeof restored.weight).toBe('bigint');
  });

  it('serves the cached payload while the validator is unchanged', async () => {
    const load = vi.fn(async () => [{ id: 1n }]);
    const validator = vi.fn(async () => 42n);

    const first = await cacheValidated('rulesets', 'k', validator, load);
    const second = await cacheValidated('rulesets', 'k', validator, load);

    expect(first).toEqual([{ id: 1n }]);
    expect(second).toEqual([{ id: 1n }]);
    // The expensive read runs once; the cheap validator runs each time.
    expect(load).toHaveBeenCalledTimes(1);
    expect(validator).toHaveBeenCalledTimes(2);
  });

  it('reloads when the validator moves — a newly queued ruleset', async () => {
    let latest = 42n;
    const load = vi.fn(async () => [{ id: latest }]);
    const validator = vi.fn(async () => latest);

    await cacheValidated('rulesets', 'k', validator, load);
    latest = 43n;
    const after = await cacheValidated('rulesets', 'k', validator, load);

    expect(after).toEqual([{ id: 43n }]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('falls back to a live load when the validator is unreadable', async () => {
    const load = vi.fn(async () => ['live']);
    const failing = vi.fn(async () => {
      throw new Error('rpc down');
    });

    // Never serve a possibly-stale payload we could not prove current.
    expect(await cacheValidated('rulesets', 'k', failing, load)).toEqual(['live']);
    expect(await cacheValidated('rulesets', 'k', failing, load)).toEqual(['live']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(cacheGet('rulesets', 'k')).toBeUndefined();
  });

  it('survives a corrupt entry instead of throwing', () => {
    localStorage.setItem('jb-cache:v1:rulesets:bad', '{ not json');
    expect(cacheGet('rulesets', 'bad')).toBeUndefined();
  });

  it('skips entries over the per-entry budget rather than blowing the quota', () => {
    cacheSet('rulesets', 'huge', { blob: 'x'.repeat(500000) });
    expect(cacheGet('rulesets', 'huge')).toBeUndefined();
  });

  it('returns a stale value synchronously, then stores and reports the fresh value', async () => {
    cacheSet('projects', 'mainnet:1:7', { name: 'Old', supply: 1n });
    var resolveFresh;
    var load = vi.fn(() => new Promise((resolve) => { resolveFresh = resolve; }));
    var onFresh = vi.fn();

    var stale = cacheStale('projects', 'mainnet:1:7', load, onFresh);
    expect(stale).toEqual({ name: 'Old', supply: 1n });
    expect(load).toHaveBeenCalledOnce();
    expect(onFresh).not.toHaveBeenCalled();

    resolveFresh({ name: 'New', supply: 2n });
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith({ name: 'New', supply: 2n }));
    expect(cacheGet('projects', 'mainnet:1:7')).toEqual({ name: 'New', supply: 2n });
  });

  it('keeps stale data unconfirmed when the background refresh fails', async () => {
    cacheSet('projects', 'mainnet:1:7', { name: 'Still readable' });
    var onFresh = vi.fn();

    expect(cacheStale(
      'projects',
      'mainnet:1:7',
      async () => { throw new Error('indexer unavailable'); },
      onFresh,
    )).toEqual({ name: 'Still readable' });

    await Promise.resolve();
    await Promise.resolve();
    expect(onFresh).not.toHaveBeenCalled();
    expect(cacheGet('projects', 'mainnet:1:7')).toEqual({ name: 'Still readable' });
  });
});
