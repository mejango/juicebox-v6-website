import { describe, expect, it, vi } from 'vitest';
import {
  contractGasWithHeadroom,
  contractGasWithinCap,
  gasWithHeadroom,
  gasWithinCap,
  transactionGasWithHeadroom,
} from '../src/gas.js';

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

  it('sends the measured limit instead of the reviewed cap the wallet would reserve', async function () {
    // A wallet reserves gas * maxFeePerGas up front, so sending the 1.5M-gas
    // project-handle cap demanded ~$4 of mainnet ETH for a call that burns a
    // fraction of it, and rejected accounts that could afford it several times over.
    var txClient = { estimateGas: vi.fn().mockResolvedValue(120000n) };
    var contractClient = { estimateContractGas: vi.fn().mockResolvedValue(150000n) };
    await expect(gasWithinCap(txClient, { to: '0x' }, 1500000n)).resolves.toBe(240000n);
    await expect(contractGasWithinCap(contractClient, {}, 5000000n)).resolves.toBe(300000n);
    // Estimation stays bounded by the reviewed cap.
    expect(txClient.estimateGas).toHaveBeenCalledWith({ to: '0x', gas: 1500000n });
    expect(contractClient.estimateContractGas).toHaveBeenCalledWith({ gas: 5000000n });
  });

  it('never exceeds the cap and keeps it when the node cannot estimate', async function () {
    var high = { estimateGas: vi.fn().mockResolvedValue(900000n) };
    var broken = { estimateGas: vi.fn().mockRejectedValue(new Error('cannot estimate')) };
    await expect(gasWithinCap(high, {}, 1000000n)).resolves.toBe(1000000n);
    await expect(gasWithinCap(broken, {}, 1000000n)).resolves.toBe(1000000n);
  });
});
