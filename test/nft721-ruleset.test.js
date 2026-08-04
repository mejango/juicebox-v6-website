import { decodeFunctionData, encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  JB_RULESET_METADATA_APP_BITS_MAX,
  build721RulesetMetadata,
  buildOwnerMintTierIds,
  decode721RulesetMetadata,
} from '../src/nft721-ruleset.js';
import { __test, buildQueueRulesetConfigs } from '../src/create-flow.js';

const MINT_FOR_ABI = [{
  type: 'function', name: 'mintFor', stateMutability: 'nonpayable',
  inputs: [{ name: 'tierIds', type: 'uint16[]' }, { name: 'beneficiary', type: 'address' }], outputs: [],
}];
const BENEFICIARY = '0x1111111111111111111111111111111111111111';

describe('721 ruleset metadata and owner mint', () => {
  it('sets and clears the transfer bit without erasing unrelated integration bits', () => {
    expect(build721RulesetMetadata({ metadata: 1 << 2, pauseTransfers: true })).toBe(5);
    expect(build721RulesetMetadata({ metadata: 5, pauseTransfers: false })).toBe(4);
    expect(decode721RulesetMetadata(5)).toEqual({
      pauseTransfers: true,
      pauseMintPendingReserves: false,
    });
  });

  it('rejects values outside JBRulesetMetadata.metadata uint14', () => {
    expect(() => build721RulesetMetadata({ metadata: -1 })).toThrow(/between 0/);
    expect(() => decode721RulesetMetadata(JB_RULESET_METADATA_APP_BITS_MAX + 1)).toThrow(/between 0/);
    expect(() => build721RulesetMetadata({ metadata: 1.5 })).toThrow(/integer/);
  });

  it('round-trips the exact repeated uint16 quantity encoding for mintFor', () => {
    const tierIds = buildOwnerMintTierIds(7, 3);
    const data = encodeFunctionData({ abi: MINT_FOR_ABI, functionName: 'mintFor', args: [tierIds, BENEFICIARY] });
    expect(tierIds).toEqual([7, 7, 7]);
    expect(decodeFunctionData({ abi: MINT_FOR_ABI, data })).toEqual({
      functionName: 'mintFor', args: [[7, 7, 7], BENEFICIARY],
    });
  });

  it('bounds tier ids and owner-mint batch size before simulation', () => {
    expect(() => buildOwnerMintTierIds(0, 1)).toThrow(/tier ID/);
    expect(() => buildOwnerMintTierIds(0x10000, 1)).toThrow(/tier ID/);
    expect(() => buildOwnerMintTierIds(7, 0)).toThrow(/between 1 and 50/);
    expect(() => buildOwnerMintTierIds(7, 51)).toThrow(/between 1 and 50/);
  });

  it('encodes a custom-project ruleset pause while preserving another integration bit', () => {
    const state = __test.initState();
    state.projectType = 'custom'; state.chainIds = [1]; state.accepts = ['eth'];
    state.stages[0].metadataExtra = 1 << 2;
    state.stages[0].pause721Transfers = true;
    expect(buildQueueRulesetConfigs(state, 1, 0)[0].metadata.metadata).toBe(5);
  });
});
