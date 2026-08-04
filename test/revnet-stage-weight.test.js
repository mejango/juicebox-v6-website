// Revnet stage issuance encoding (P0-1): a blank later-stage weight means "keep the previous stage's
// (cut) issuance", which JBRulesets encodes as the raw sentinel weight 1 — NOT 0. Encoding 0 turns
// issuance off permanently for the rest of the revnet's life (nana-core JBRulesets: "A weight of 1 is a
// special case that represents inheriting the cut weight of the previous ruleset").
import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { __test, createStage } from '../src/create-flow.js';

const { initState, buildRevnetArgs } = __test;

const ALICE = '0x1111111111111111111111111111111111111111';
const SALT = '0x' + '00'.repeat(32);

// A minimal 2-stage mainnet revnet state; stage-2 weight comes from `stage2Weight`.
function revState(stage2Weight) {
  const s = initState();
  s.projectType = 'revnet';
  s.network = 'mainnet';
  s.chainIds = [1];
  s.accepts = ['eth'];
  s.details = Object.assign(s.details, { name: 'Test', ticker: 'TST', owner: ALICE });
  s.revOperator = ALICE;
  const stage2 = createStage();
  stage2.weight = stage2Weight;
  s.stages.push(stage2);
  return s;
}

function stagesOf(state) {
  const tx = buildRevnetArgs(state, 1, ALICE, 'ipfs://x', SALT, 1000000);
  return { tx, stages: tx.args[1].stageConfigurations };
}

describe('buildRevnetArgs — stage initialIssuance encoding', () => {
  it('blank stage-2 weight encodes the inherit sentinel 1n (NOT 0n = permanent zero issuance)', () => {
    const { stages } = stagesOf(revState(''));
    expect(stages).toHaveLength(2);
    expect(stages[1].initialIssuance).toBe(1n);
  });

  it('explicit stage-2 weight encodes 18-dec fixed point; explicit "0" stays zero issuance', () => {
    expect(stagesOf(revState('100')).stages[1].initialIssuance).toBe(100n * 10n ** 18n);
    expect(stagesOf(revState('0')).stages[1].initialIssuance).toBe(0n);
  });

  it('blank stage-1 weight encodes explicit 0n (matches the stage summary, which displays "0")', () => {
    const s = revState('');
    s.stages[0].weight = '';
    const { stages } = stagesOf(s);
    // Stage 1 has no previous ruleset to inherit from — blank must NOT become the sentinel 1n.
    expect(stages[0].initialIssuance).toBe(0n);
    // And stage 2's blank still chains the inherit sentinel (inherits stage 1's explicit 0).
    expect(stages[1].initialIssuance).toBe(1n);
  });

  it('the encoded config round-trips through the REVDeployer.deployFor ABI with the sentinel intact', () => {
    const { tx } = stagesOf(revState(''));
    const data = encodeFunctionData({ abi: tx.abi, functionName: 'deployFor', args: tx.args });
    const back = decodeFunctionData({ abi: tx.abi, data });
    expect(back.args[1].stageConfigurations[1].initialIssuance).toBe(1n);
  });

  it('encodes the shop transfer pause in each precommitted stage without erasing other metadata bits', () => {
    const state = revState('');
    state.stages[0].metadataExtra = 1 << 2;
    state.stages[0].pause721Transfers = true;
    const { stages } = stagesOf(state);
    expect(stages[0].extraMetadata).toBe(5);
    expect(stages[1].extraMetadata).toBe(0);
  });
});
