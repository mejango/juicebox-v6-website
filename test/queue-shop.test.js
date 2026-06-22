// Stage E — queueing a ruleset must let the user keep / remove the 721 shop, and must NOT silently drop a
// live shop. On single-chain the 721 hook IS metadata.dataHook; the encoder's default (dataHook=0) detaches
// it, so "continue" has to re-pass the hook. On omnichain the shop rides the deploy721 empty-tiers
// carry-forward, so the queue branch must leave metadata.dataHook alone. The branch is gated on
// state.shopChoice so the LAUNCH path (which never sets it) is untouched — that non-regression is the
// load-bearing guard, since assembleRuleset is shared by launch + queue.
import { describe, it, expect } from 'vitest';
import { __test } from '../src/create-flow.js';

const { initState, assembleRuleset } = __test;
const ALICE = '0x1111111111111111111111111111111111111111';
const HOOK = '0x000000000000000000000000000000000000AAaA';

function queueState(over) {
  const s = initState();
  s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth'];
  s.details = Object.assign(s.details, { name: 'T', owner: ALICE });
  s.stages[0].weight = '1000'; s.stages[0].durationSeconds = 2592000; s.stages[0].cashOutEnabled = true;
  return Object.assign(s, over || {});
}
const rsFor = (s) => assembleRuleset(s, s.stages[0], 0, 1, true, true, 0);

describe('queue-ruleset 721-shop choice → ruleset data-hook metadata', () => {
  it('continue (single-chain) re-passes the current hook so the shop is NOT dropped', () => {
    const rs = rsFor(queueState({ shopChoice: 'continue', currentDataHook: HOOK, currentUseDataHookForCashOut: true, isOmnichain: false }));
    expect(rs.dataHook).toBe(HOOK);
    expect(rs.useDataHookForPay).toBe(true);
    expect(rs.useDataHookForCashOut).toBe(true);
  });
  it('continue preserves useDataHookForCashOut=false (a pay-only shop)', () => {
    const rs = rsFor(queueState({ shopChoice: 'continue', currentDataHook: HOOK, currentUseDataHookForCashOut: false, isOmnichain: false }));
    expect(rs.dataHook).toBe(HOOK);
    expect(rs.useDataHookForCashOut).toBe(false);
  });
  it('remove (single-chain) detaches the shop (dataHook 0, both flags off)', () => {
    const rs = rsFor(queueState({ shopChoice: 'remove', currentDataHook: HOOK, isOmnichain: false }));
    expect(rs.dataHook).toBe('');
    expect(rs.useDataHookForPay).toBe(false);
    expect(rs.useDataHookForCashOut).toBe(false);
  });
  it('omnichain continue does NOT touch metadata.dataHook (shop rides the carry-forward)', () => {
    const rs = rsFor(queueState({ shopChoice: 'continue', currentDataHook: HOOK, isOmnichain: true }));
    expect(rs.dataHook).not.toBe(HOOK);
    expect(rs.useDataHookForPay).toBeFalsy();
  });
  it('LAUNCH non-regression: no shopChoice → the queue branch never runs, data hook untouched', () => {
    const rs = rsFor(queueState({})); // shopChoice undefined (the launch path)
    expect(rs.dataHook).not.toBe(HOOK);
    expect(rs.useDataHookForPay).toBeFalsy();
  });
});
