import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCustomRpc, setCustomRpc } from '../src/chain.js';

// Safari private windows and sandboxed Safe-App iframes throw on ANY localStorage access.
// The custom-RPC helpers must degrade to "no override" instead of crashing chain resolution.
describe('custom RPC storage guards', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.removeItem('jb-rpc-1');
  });

  it('round-trips a custom RPC through localStorage when storage works', () => {
    setCustomRpc(1, 'https://rpc.example');
    expect(getCustomRpc(1)).toBe('https://rpc.example');
    setCustomRpc(1, '');
    expect(getCustomRpc(1)).toBe('');
  });

  it('returns the empty default when storage access throws', () => {
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('SecurityError: blocked'); },
      setItem() { throw new Error('SecurityError: blocked'); },
      removeItem() { throw new Error('SecurityError: blocked'); },
    });
    expect(() => getCustomRpc(1)).not.toThrow();
    expect(getCustomRpc(1)).toBe('');
    expect(() => setCustomRpc(1, 'https://rpc.example')).not.toThrow();
    expect(() => setCustomRpc(1, '')).not.toThrow();
  });
});
