// The confirm modal must NEVER show "could not decode" when the function + calldata are known. Builders use
// different field names (auto-issue uses data/functionName/rawArgs; relayr uses calldata; executeTransaction
// uses function/args). decodeCallForDisplay normalizes these so every signing path shows a decoded tx.
// Regression for the "Confirm auto issue" → REVOwner.autoIssueFor "could not decode" bug.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData } from 'viem';
import { decodeCallForDisplay } from '../src/component-base.js';

const REVO = '0x2ba4705ad0332cdfb299b452068438bcba3faaf3';
const AUTOISSUE_ABI = [{ type: 'function', name: 'autoIssueFor', stateMutability: 'nonpayable',
  inputs: [{ name: 'revnetId', type: 'uint256' }, { name: 'stageId', type: 'uint256' }, { name: 'beneficiary', type: 'address' }], outputs: [] }];

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
});
