export var APPROVAL_STATUS = {
  Empty: 0,
  Upcoming: 1,
  Active: 2,
  ApprovalExpected: 3,
  Approved: 4,
  Failed: 5,
};

function sameRuleset(a, b) {
  return !!a && !!b && BigInt(a.id) === BigInt(b.id);
}

// Turn the contract's queue lifecycle into safe owner choices. `upcoming` is
// the next distinct stored configuration, while `latest` is the tail returned
// by latestQueuedRulesetOf. Simulated auto-cycles must be filtered by callers.
export function planRulesetQueue(args) {
  var current = args.current;
  var upcoming = args.upcoming && !sameRuleset(args.upcoming, current) ? args.upcoming : null;
  var latest = args.latest && !sameRuleset(args.latest, current) ? args.latest : null;
  if (!latest) {
    return {
      defaultAction: 'current', hasQueuedRuleset: false, hasMultipleQueuedRulesets: false,
      options: [{ action: 'current', source: current, mustStartAtOrAfter: 0, requiresStartDate: false }],
    };
  }

  var options = [];
  var latestReplaceable = args.latestApprovalStatus !== APPROVAL_STATUS.Approved
    && args.latestApprovalStatus !== APPROVAL_STATUS.Active;
  var replaceTarget = latestReplaceable ? latest : null;
  if (replaceTarget) {
    options.push({
      action: 'replace', source: replaceTarget,
      mustStartAtOrAfter: Number(replaceTarget.start), requiresStartDate: false,
    });
  }
  if (args.latestApprovalStatus === APPROVAL_STATUS.Approved
    || args.latestApprovalStatus === APPROVAL_STATUS.ApprovalExpected
    || args.latestApprovalStatus === APPROVAL_STATUS.Empty) {
    var duration = Number(latest.duration);
    options.push({
      action: 'after', source: latest,
      mustStartAtOrAfter: duration > 0 ? Number(latest.start) + duration : null,
      requiresStartDate: duration === 0,
    });
  }
  // A CUSTOM approval hook reporting Active satisfies neither branch above: replace excludes
  // Active, and after only accepts Approved/ApprovalExpected/Empty. That left `options` empty
  // while `defaultAction` fell through to 'current' — an action not in the list — so the
  // editor threw a raw error even though queueing is perfectly possible on-chain. Preset
  // JBDeadline hooks never report Active, so this only ever hit custom-hook projects.
  // The effective start under an unknown hook can't be computed, so the owner names one.
  if (!options.length) {
    options.push({
      action: 'after', source: latest,
      mustStartAtOrAfter: null, requiresStartDate: true,
    });
  }

  return {
    // Preserve an existing queued configuration unless the owner explicitly
    // chooses to replace it.
    defaultAction: options.some(function (o) { return o.action === 'after'; }) ? 'after' : (options[0] ? options[0].action : 'current'),
    options: options,
    hasQueuedRuleset: true,
    hasMultipleQueuedRulesets: !!upcoming && !sameRuleset(upcoming, latest),
  };
}

export function approvalStatusLabel(status) {
  if (status === APPROVAL_STATUS.Empty) return 'No approval hook';
  if (status === APPROVAL_STATUS.Upcoming) return 'Approval not available yet';
  if (status === APPROVAL_STATUS.Active) return 'Active';
  if (status === APPROVAL_STATUS.ApprovalExpected) return 'Approval expected';
  if (status === APPROVAL_STATUS.Approved) return 'Approved';
  if (status === APPROVAL_STATUS.Failed) return 'Approval failed';
  return 'Unknown approval status';
}
