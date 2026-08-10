import { describe, expect, it, vi } from 'vitest';
import { contractGasWithHeadroom, gasWithHeadroom, transactionGasWithHeadroom } from '../src/gas.js';

describe('client gas headroom', function () {
  it('sets an explicit 2x limit', function () {
    expect(gasWithHeadroom(1119186n)).toBe(2238372n);
  });

  it('removes a stale gas cap before estimating contract and raw transactions', async function () {
    var contractClient = { estimateContractGas: vi.fn().mockResolvedValue(100000n) };
    var txClient = { estimateGas: vi.fn().mockResolvedValue(21000n) };
    await expect(contractGasWithHeadroom(contractClient, { gas: 1n })).resolves.toBe(200000n);
    await expect(transactionGasWithHeadroom(txClient, { gas: 1n })).resolves.toBe(42000n);
    expect(contractClient.estimateContractGas).toHaveBeenCalledWith({ gas: undefined });
    expect(txClient.estimateGas).toHaveBeenCalledWith({ gas: undefined });
  });
});
