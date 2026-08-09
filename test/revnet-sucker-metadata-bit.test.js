// REVDeployer.deploySuckersFor reads bit 2 of the CURRENT stage's app metadata and reverts
// without it (REVDeployer.sol:646-650). Revnet stages are IMMUTABLE, so a stage launched
// without the bit can never be extended to another chain. Launch-time suckers are exempt
// (REVDeployer.sol:876-882), which is why a missing bit stays invisible until someone tries
// to extend — hence this pin.
import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionData } from 'viem';
import { __test, createStage } from '../src/create-flow.js';

const { initState, buildRevnetArgs } = __test;

const ALICE = '0x1111111111111111111111111111111111111111';
const SALT = '0x' + '00'.repeat(32);
const ALLOW_SUCKER_DEPLOYMENT = 1 << 2;

function revState({ stageCount = 1, metadataExtra, pause721Transfers } = {}) {
  const s = initState();
  s.projectType = 'revnet';
  s.network = 'mainnet';
  s.chainIds = [1];
  s.accepts = ['eth'];
  s.details = Object.assign(s.details, { name: 'Test', ticker: 'TST', owner: ALICE });
  s.revOperator = ALICE;
  for (let i = 1; i < stageCount; i++) s.stages.push(createStage());
  for (const stage of s.stages) {
    if (metadataExtra !== undefined) stage.metadataExtra = metadataExtra;
    if (pause721Transfers !== undefined) stage.pause721Transfers = pause721Transfers;
  }
  return s;
}

const stagesOf = (state) =>
  buildRevnetArgs(state, 1, ALICE, 'ipfs://x', SALT, 1000000).args[1].stageConfigurations;

describe('buildRevnetArgs — allow-sucker-deployment metadata bit', () => {
  it('sets the bit on every stage by default', () => {
    const stages = stagesOf(revState({ stageCount: 3 }));
    expect(stages).toHaveLength(3);
    for (const stage of stages) {
      expect(stage.extraMetadata & ALLOW_SUCKER_DEPLOYMENT).toBe(ALLOW_SUCKER_DEPLOYMENT);
    }
  });

  it('keeps the 721 transfer gate closed regardless of stale stage state', () => {
    const [stage] = stagesOf(revState({ pause721Transfers: false }));
    expect(stage.extraMetadata).toBe(1 | ALLOW_SUCKER_DEPLOYMENT);
  });

  it('does not double-set when the stage already carries the bit', () => {
    const [stage] = stagesOf(revState({ metadataExtra: ALLOW_SUCKER_DEPLOYMENT }));
    expect(stage.extraMetadata).toBe(1 | ALLOW_SUCKER_DEPLOYMENT);
  });

  it('survives a round-trip through the REVDeployer.deployFor ABI', () => {
    const tx = buildRevnetArgs(revState(), 1, ALICE, 'ipfs://x', SALT, 1000000);
    const back = decodeFunctionData({
      abi: tx.abi,
      data: encodeFunctionData({ abi: tx.abi, functionName: 'deployFor', args: tx.args }),
    });
    const [stage] = back.args[1].stageConfigurations;
    expect(stage.extraMetadata & ALLOW_SUCKER_DEPLOYMENT).toBe(ALLOW_SUCKER_DEPLOYMENT);
  });
});
