// A later custom-flow ruleset can wait N cycles of the previous one or start on a date; one cycle keeps
// the 0 encoding (next boundary), and a launch-queued stage sooner than the JBDeadline notice is blocked.
import { describe, it, expect } from 'vitest';
import { __test, buildQueueRulesetConfigs, createStage, deriveStartFrom } from '../src/create-flow.js';

const { initState, noticeClashIssue, stageMustStartAtOrAfter } = __test;
const day = 86400;

function twoStage(startCycles) {
  const s = initState();
  s.projectType = 'custom'; s.chainIds = [1]; s.accepts = ['eth'];
  s.stages[0].durationSeconds = day;
  const second = createStage();
  second.startCycles = startCycles;
  s.stages.push(second);
  return s;
}

describe('later ruleset start', () => {
  it('mirrors JBRulesets.deriveStartFrom', () => {
    expect(deriveStartFrom(1000, 0, 5000)).toBe(5000);
    expect(deriveStartFrom(1000, day, 0)).toBe(1000 + day);
    expect(deriveStartFrom(1000, day, 1000 + 3 * day)).toBe(1000 + 3 * day);
    expect(deriveStartFrom(1000, day, 1000 + 3 * day + 1)).toBe(1000 + 4 * day);
  });

  it('encodes one cycle as 0 and N cycles as an absolute boundary', () => {
    expect(stageMustStartAtOrAfter({ startMode: 'cycles', startCycles: '1' }, 1000, day)).toBe(0);
    expect(stageMustStartAtOrAfter({ startMode: 'cycles', startCycles: '3' }, 1000, day)).toBe(1000 + 3 * day);
    expect(stageMustStartAtOrAfter({ startMode: 'date', startDate: '1800000000' }, 1000, day)).toBe(1800000000);
  });

  it('chains a 3-cycle second ruleset off the first in the encoded configs', () => {
    const now = Math.floor(Date.now() / 1000);
    const cfgs = buildQueueRulesetConfigs(twoStage('3'), 1, 0);
    expect(cfgs).toHaveLength(2);
    expect(Number(cfgs[0].mustStartAtOrAfter)).toBe(0);
    const second = Number(cfgs[1].mustStartAtOrAfter);
    expect(second).toBeGreaterThanOrEqual(now + 3 * day);
    expect(second).toBeLessThan(now + 3 * day + 60);
    expect(Number(buildQueueRulesetConfigs(twoStage('1'), 1, 0)[1].mustStartAtOrAfter)).toBe(0);
  });

  it('blocks a launch whose second ruleset starts sooner than the deadline hook allows', () => {
    const s = twoStage('1');
    s.stages.forEach((st) => { st.deadline = '3days'; });
    expect(noticeClashIssue(s)).toMatch(/Ruleset #2 would start 1 day after launch/);
    s.stages[0].startCycles = '1'; s.stages[1].startCycles = '3';
    expect(noticeClashIssue(s)).toBeNull();
    s.stages.forEach((st) => { st.deadline = 'none'; });
    expect(noticeClashIssue(s)).toBeNull();
  });

  it('blocks the auto-appended standby ruleset on the same rule', () => {
    const s = initState();
    s.projectType = 'custom'; s.chainIds = [1]; s.accepts = ['eth'];
    s.stages[0].durationSeconds = day; s.stages[0].deadline = '3days'; s.afterMode = 'wait';
    expect(noticeClashIssue(s)).toMatch(/closing ruleset/);
  });
});
