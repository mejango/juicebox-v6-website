// Reads try the keyless public provider first and JB Center's keyless read gateway second, so an
// IPFS-hosted copy keeps working when publicnode flakes. A user-set custom RPC replaces both.
import { describe, it, expect } from 'vitest';
import { fallbackRpcFor, readRpcUrlsFor } from '../src/chain.js';

describe('read RPC fallback', () => {
  it('lists publicnode then JB Center for a supported mainnet', () => {
    expect(readRpcUrlsFor(8453, '')).toEqual([
      'https://base-rpc.publicnode.com',
      'https://juicebox.center/v1/rpc/8453',
    ]);
  });
  it('keeps viem\'s chain default as the testnet primary with JB Center behind it', () => {
    expect(readRpcUrlsFor(84532, '')).toEqual([undefined, 'https://juicebox.center/v1/rpc/84532']);
    expect(readRpcUrlsFor(999, '')).toEqual([undefined]);
    expect(fallbackRpcFor(999)).toBeUndefined();
  });
  it('lets a custom RPC replace both', () => {
    expect(readRpcUrlsFor(1, 'https://rpc.example')).toEqual(['https://rpc.example']);
  });
});
