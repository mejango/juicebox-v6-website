// Every approval step proves its allowance landed by reading pinned to the approval receipt's block.
// A load-balanced public RPC answers that read with JSON-RPC -32001 ("block not found") whenever the
// node it lands on has not imported that block yet — which killed payments on revnet.money between the
// approval and the swap. The transport waits the lag out instead of failing the payment.
import { describe, it, expect, vi } from 'vitest';
import { createPublicClient, erc20Abi } from 'viem';
import { base } from 'viem/chains';
import { withBlockLagRetry } from '../src/wallet.js';

const blockAhead = () => Object.assign(new Error('block not found'), { code: -32001 });

function stubTransport(request) {
  return () => ({ config: { key: 'stub', name: 'stub', type: 'stub' }, request, value: undefined });
}

describe('RPC block lag', () => {
  it('retries a read pinned to a block the answering node has not imported yet', async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(blockAhead())
      .mockRejectedValueOnce(blockAhead())
      .mockResolvedValue('0x2a');

    const transport = withBlockLagRetry(stubTransport(request), [0, 0, 0])({});

    await expect(transport.request({ method: 'eth_call' })).resolves.toBe('0x2a');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('rethrows once the lag retries are spent', async () => {
    const request = vi.fn().mockRejectedValue(blockAhead());
    const transport = withBlockLagRetry(stubTransport(request), [0, 0])({});

    await expect(transport.request({ method: 'eth_call' })).rejects.toMatchObject({ code: -32001 });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('never retries a revert or any other RPC error', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('reverted'), { code: 3 }));
    const transport = withBlockLagRetry(stubTransport(request), [0, 0])({});

    await expect(transport.request({ method: 'eth_call' })).rejects.toMatchObject({ code: 3 });
    expect(request).toHaveBeenCalledOnce();
  });

  it('carries a pinned allowance read through a lagging backend', async () => {
    let calls = 0;
    const request = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw blockAhead();
      return `0x${(1000000n).toString(16).padStart(64, '0')}`;
    });
    const client = createPublicClient({
      chain: base,
      transport: withBlockLagRetry(stubTransport(request), [0]),
    });

    const allowance = await client.readContract({
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      abi: erc20Abi,
      functionName: 'allowance',
      args: ['0x000000000000000000000000000000000000dEaD', '0x000000000000000000000000000000000000bEEF'],
      blockNumber: 50623163n,
    });

    expect(allowance).toBe(1000000n);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
