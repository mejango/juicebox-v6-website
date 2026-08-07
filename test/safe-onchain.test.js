// On-chain Safe path (for chains with no hosted Safe Transaction Service, e.g. Arbitrum/OP Sepolia). The propose
// flow branches on hasSafeService; the on-chain approve/execute coordinate around safeTxHashForCall, which must
// bind the chainId (EIP-712 domain) + nonce + calldata so a signer can't approve one tx and execute another.
import { describe, it, expect } from 'vitest';
import { hasSafeService, safeTxHashForCall } from '../src/safe.js';

describe('hasSafeService', () => {
  it('true where Safe hosts a tx-service; false for the chains without one', () => {
    // Probed against api.safe.global/tx-service/<prefix>/api/v1/about/: Base Sepolia
    // (`basesep`) returns 200 and was previously excluded, dropping those Safes to the
    // on-chain approveHash path with no queue links. OP Sepolia (`opsepolia`) and Arbitrum
    // Sepolia (`arb1-sep`) genuinely 404.
    [1, 10, 8453, 42161, 11155111, 84532].forEach((c) => expect(hasSafeService(c)).toBe(true));
    [421614, 11155420].forEach((c) => expect(hasSafeService(c)).toBe(false));
  });
});

describe('safeTxHashForCall', () => {
  const safe = '0x240dc2085caef779f428dcd103cfd2fb510ede82';
  const call = { to: '0x1111111111111111111111111111111111111111', data: '0xabcdef', value: 0, nonce: 5 };

  it('is a 32-byte hash, deterministic for the same call', () => {
    const h = safeTxHashForCall(11155420, safe, call);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(safeTxHashForCall(11155420, safe, call)).toBe(h);
  });

  it('binds chainId, nonce, and calldata (no approve-one / execute-another)', () => {
    const base = safeTxHashForCall(11155420, safe, call);
    expect(safeTxHashForCall(421614, safe, call)).not.toBe(base);                  // chainId is in the EIP-712 domain
    expect(safeTxHashForCall(11155420, safe, { ...call, nonce: 6 })).not.toBe(base); // nonce
    expect(safeTxHashForCall(11155420, safe, { ...call, data: '0x00' })).not.toBe(base); // calldata
    expect(safeTxHashForCall(11155420, '0x000000000000000000000000000000000000dEaD', call)).not.toBe(base); // verifyingContract
  });
});
