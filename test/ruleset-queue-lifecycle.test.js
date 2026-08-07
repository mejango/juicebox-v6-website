import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, planRulesetQueue } from '../src/ruleset-queue-lifecycle.js';

var current = { id: 10, cycleNumber: 7, start: 100, duration: 30 };
var queued = { id: 11, cycleNumber: 8, start: 130, duration: 30 };
var tail = { id: 12, cycleNumber: 9, start: 160, duration: 30 };

describe('planRulesetQueue', function () {
  it('bases an empty queue on the current ruleset', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: current, latest: current,
      latestApprovalStatus: APPROVAL_STATUS.Active,
    });
    expect(plan.defaultAction).toBe('current');
    expect(plan.options[0]).toMatchObject({ action: 'current', source: current, mustStartAtOrAfter: 0 });
  });

  it('offers replacement and append while approval is expected', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: queued, latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options.map(function (o) { return o.action; })).toEqual(['replace', 'after']);
    expect(plan.defaultAction).toBe('after');
    expect(plan.options[0].mustStartAtOrAfter).toBe(queued.start);
    expect(plan.options[1].mustStartAtOrAfter).toBe(queued.start + queued.duration);
  });

  it('does not allow an approved queued cycle to be replaced', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: queued, latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.Approved,
    });
    expect(plan.options.map(function (o) { return o.action; })).toEqual(['after']);
  });

  it('does not use a failed queued ruleset as an append parent', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: queued, latest: queued,
      latestApprovalStatus: APPROVAL_STATUS.Failed,
    });
    expect(plan.options.map(function (o) { return o.action; })).toEqual(['replace']);
  });

  it('uses the queue tail for both replacement and append', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: queued, latest: tail,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.hasMultipleQueuedRulesets).toBe(true);
    expect(plan.options[0].source).toBe(tail);
    expect(plan.options[1].source).toBe(tail);
  });

  it('preserves earlier queued rules and replaces a non-final tail', function () {
    var plan = planRulesetQueue({
      current: current, upcoming: queued, latest: tail,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options[0]).toMatchObject({ action: 'replace', source: tail });
  });

  it('requires a date after a flexible queued ruleset', function () {
    var flexible = Object.assign({}, queued, { duration: 0 });
    var plan = planRulesetQueue({
      current: current, upcoming: flexible, latest: flexible,
      latestApprovalStatus: APPROVAL_STATUS.ApprovalExpected,
    });
    expect(plan.options.find(function (o) { return o.action === 'after'; })).toMatchObject({
      requiresStartDate: true, mustStartAtOrAfter: null,
    });
  });
});

// A CUSTOM approval hook reporting Active on a QUEUED ruleset satisfies neither the replace
// branch (which excludes Active) nor the after branch (Approved/ApprovalExpected/Empty only).
// That left the option list empty while defaultAction fell through to 'current' — an action
// not in the list — so the editor threw a raw error even though queueing was possible
// on-chain. Preset JBDeadline hooks never report Active, so only custom-hook projects hit it.
describe('custom approval hook reporting Active on a queued ruleset', function () {
  var args = {
    current: current, upcoming: queued, latest: queued,
    latestApprovalStatus: APPROVAL_STATUS.Active,
  };

  it('still offers an action, and the default is one of the options', function () {
    var plan = planRulesetQueue(args);
    expect(plan.options.length).toBeGreaterThan(0);
    expect(plan.options.map(function (o) { return o.action; })).toContain(plan.defaultAction);
  });

  it('asks the owner for a start date, since the hook makes it uncomputable', function () {
    var plan = planRulesetQueue(args);
    var option = plan.options.find(function (o) { return o.action === plan.defaultAction; });
    expect(option.requiresStartDate).toBe(true);
    expect(option.mustStartAtOrAfter).toBeNull();
  });
});
