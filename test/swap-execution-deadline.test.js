// A swap's deadline is stamped when the transaction is PROPOSED, not when it executes. An EOA reviews
// and signs in one sitting, but a multisig collects co-signatures for hours or days — a 30-minute window
// guarantees the last owner signs a swap that can no longer execute (and burns a Safe nonce finding out).
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ safe: false }));

vi.mock('../src/wallet.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, isSafeConnected: vi.fn(() => h.safe) };
});

import { swapExecutionDeadline } from '../src/discover.js';

const NOW = 1_800_000_000;

describe('swapExecutionDeadline', () => {
  it('gives an EOA 30 minutes', () => {
    h.safe = false;
    expect(swapExecutionDeadline(NOW)).toBe(BigInt(NOW + 1800));
  });

  it('gives a multisig 30 days so the signing queue cannot outlive the swap', () => {
    h.safe = true;
    expect(swapExecutionDeadline(NOW)).toBe(BigInt(NOW + 30 * 24 * 3600));
  });

  it('defaults to the current clock when no timestamp is supplied', () => {
    h.safe = false;
    const before = Math.floor(Date.now() / 1000) + 1800;
    const deadline = swapExecutionDeadline();
    expect(deadline).toBeGreaterThanOrEqual(BigInt(before));
    expect(deadline).toBeLessThanOrEqual(BigInt(before + 5));
  });

  it('reads the connection at call time, not at module load', () => {
    h.safe = false;
    const eoa = swapExecutionDeadline(NOW);
    h.safe = true;
    expect(swapExecutionDeadline(NOW)).toBeGreaterThan(eoa);
  });
});
