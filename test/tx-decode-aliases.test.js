// The confirm modal must NEVER show "could not decode" when the function + calldata are known. Builders use
// different field names (auto-issue uses data/functionName/rawArgs; relayr uses calldata; executeTransaction
// uses function/args). decodeCallForDisplay normalizes these so every signing path shows a decoded tx.
// Regression for the "Confirm auto issue" → REVOwner.autoIssueFor "could not decode" bug.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData } from 'viem';
import { decodeCallForDisplay, renderDecodedTx } from '../src/component-base.js';
import { buildAdjustTiersArgs } from '../src/discover.js';

const REVO = '0x2ba4705ad0332cdfb299b452068438bcba3faaf3';
const AUTOISSUE_ABI = [{ type: 'function', name: 'autoIssueFor', stateMutability: 'nonpayable',
  inputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'stageId', type: 'uint256' }, { name: 'beneficiary', type: 'address' }], outputs: [] }];
const INIT_POOL_ABI = [{ type: 'function', name: 'initializePoolFor', stateMutability: 'nonpayable',
  inputs: [{ name: 'projectId', type: 'uint256' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'twapWindow', type: 'uint256' }, { name: 'terminalToken', type: 'address' }, { name: 'sqrtPriceX96', type: 'uint160' }], outputs: [] }];

describe('decodeCallForDisplay normalizes tx field aliases (no more spurious "could not decode")', () => {
  it('decodes the auto-issue payload shape (data + functionName + rawArgs) via the REVOwner ABI', () => {
    const args = [1n, 1781612915n, '0x1111111111111111111111111111111111111111'];
    const data = encodeFunctionData({ abi: AUTOISSUE_ABI, functionName: 'autoIssueFor', args });
    // The exact payload openTxConfirm builds (discover.js distribute()): data/functionName/rawArgs + a named args object.
    const payload = { chain: 'Ethereum', contract: 'REVOwner', address: REVO, functionName: 'autoIssueFor', value: '0', data, rawArgs: args, args: { revnetId: '1' } };
    const dec = decodeCallForDisplay(payload);
    expect(dec).not.toBeNull();              // was null → "Could not decode this call"
    expect(dec.fn).toBe('autoIssueFor');
    expect(dec.args.map(a => a.name)).toEqual(['revnetId', 'stageId', 'beneficiary']);
  });
  it('falls back to functionName + rawArgs when there is no decodable calldata', () => {
    const dec = decodeCallForDisplay({ contract: 'REVOwner', address: REVO, functionName: 'autoIssueFor', rawArgs: [1n, 2n, REVO] });
    expect(dec).not.toBeNull();
    expect(dec.fn).toBe('autoIssueFor');
    expect(dec.args.length).toBe(3);
  });
  it('labels initializePoolFor terminalToken with the known token symbol for the review chain', () => {
    const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const data = encodeFunctionData({ abi: INIT_POOL_ABI, functionName: 'initializePoolFor', args: [6n, 10000, 200, 172800n, baseUsdc, 792390160291139450388n] });
    const node = renderDecodedTx({ chain: 'Base', chainId: 8453, contract: 'JBBuybackHookRegistry', calldata: data, value: '0' });
    expect(node.textContent).toContain('terminalToken (address):');
    expect(node.textContent).toContain('(USDC)');
  });
  it('explains initializePoolFor native terminalToken while preserving the sentinel argument', () => {
    const native = '0x000000000000000000000000000000000000EEEe';
    const data = encodeFunctionData({ abi: INIT_POOL_ABI, functionName: 'initializePoolFor', args: [3n, 10000, 200, 172800n, native, 7922816251426433759354395033600n] });
    const node = renderDecodedTx({ chain: 'Ethereum', chainId: 1, contract: 'JBBuybackHookRegistry', calldata: data, value: '0' });
    expect(node.textContent).toContain('terminalToken (address):');
    expect(node.textContent).toContain(native);
    expect(node.textContent).toContain('ETH native token');
    expect(node.textContent).toContain('address(0)');
  });
  it('decodes a project-specific 721 hook call from the ABI carried by the transaction', () => {
    const hook = '0xD32f93eB2EcB2379C96b739c73052F54A04C61A9';
    const tx = buildAdjustTiersArgs({
      chainId: 84532,
      hookAddr: hook,
      tiersToAdd: [],
      tierIdsToRemove: [1],
    });
    const data = encodeFunctionData({ abi: tx.abi, functionName: tx.functionName, args: tx.args });
    const node = renderDecodedTx({
      chain: 'Base Sepolia',
      chainId: 84532,
      contract: tx.contractName,
      address: tx.address,
      calldata: data,
      abi: tx.abi,
    });
    expect(node.textContent).toContain('JB721TiersHook');
    expect(node.textContent).toContain('adjustTiers');
    expect(node.textContent).toContain('tierIdsToRemove');
    expect(node.textContent).not.toContain('Could not decode');
  });
});
