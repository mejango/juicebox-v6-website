import { describe, expect, it } from 'vitest';
import { __test } from '../src/create-flow.js';

const { initState, buildLaunchArgs, buildRevnetArgs } = __test;
const DEAD = '0xdead000000000000000000000000000000000000';
const SALT = '0x' + '00'.repeat(32);

describe('create authority defaults', () => {
  it('sends project ownership to 0xdead when changes are not enabled', () => {
    const state = initState();
    state.projectType = 'custom';
    state.chainIds = [1];
    state.details.name = 'Immutable project';

    expect(state.details.owner).toBe(DEAD);
    const tx = buildLaunchArgs(state, 1, state.details.owner, 'ipfs://project', SALT, 0);
    expect(tx.args[0]).toBe(DEAD);
  });

  it('uses 0xdead as the default revnet operator', () => {
    const state = initState();
    state.projectType = 'revnet';
    state.chainIds = [1];
    state.details.name = 'Operatorless revnet';
    state.details.ticker = 'REV';

    expect(state.revOperator).toBe(DEAD);
    const tx = buildRevnetArgs(state, 1, DEAD, 'ipfs://revnet', SALT, 0);
    expect(tx.args[1].operator).toBe(DEAD);
  });
});
