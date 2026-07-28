// Operator feedback (kmac88): "can't figure out how to remove a reserved split … can't get this to 0."
// Two distinct levers, and both must work:
//  (1) clearing the ALLOCATION — submit an EMPTY reserved split group (JBSplits accepts it; reserved
//      tokens then accrue to the project owner), and
//  (2) stopping the RESERVATION — queue a new ruleset whose reservedPercent encodes 0. The queue flow
//      derives the rate from the sum of reserved recipient rows, so deleting every row means 0%.
// The reserved-splits editor must allow (1) and point at (2), since operators look there first.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, decodeFunctionData } from 'viem';
import { buildSplitsEditPayload } from '../src/discover.js';
import { buildQueueRulesetConfigs, __test } from '../src/create-flow.js';

const discoverSrc = readFileSync(resolve(process.cwd(), 'src/discover.js'), 'utf8');
const ZERO = '0x0000000000000000000000000000000000000000';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

function row(pct, over) {
  return Object.assign({
    isEmpty: () => false,
    pct: { value: String(pct) },
    fixedShare: null,
    orig: null,
    lockedUntilValue: () => 0,
    hookAddr: () => ZERO,
    parse: () => ({ projectId: 0n, beneficiary: BOB }),
  }, over || {});
}
const emptyRow = () => row('', { isEmpty: () => true });

// Percentages are GROUP shares (rows sum to 100% of the group), matching the other three clients.
describe('buildSplitsEditPayload — an empty group is a valid submission', () => {
  it('no rows → empty splits, no error (the group is cleared onchain)', () => {
    expect(buildSplitsEditPayload([])).toEqual({ splits: [], sumPct: 0 });
  });

  it('only blank rows → empty splits, no error', () => {
    expect(buildSplitsEditPayload([emptyRow(), emptyRow()])).toEqual({ splits: [], sumPct: 0 });
  });

  it('a filled row converts its group share to a share of 1e9', () => {
    const out = buildSplitsEditPayload([row('50')]);
    expect(out.error).toBeUndefined();
    expect(out.splits).toHaveLength(1);
    expect(out.splits[0].percent).toBe(500000000);
    expect(out.splits[0].beneficiary).toBe(BOB);
  });

  it('a locked row keeps its exact stored share and lock', () => {
    const out = buildSplitsEditPayload([row('2.5', { fixedShare: 123456789, lockedUntilValue: () => 999999 })]);
    expect(out.splits[0].percent).toBe(123456789);
    expect(out.splits[0].lockedUntil).toBe(999999);
  });

  it('still rejects a non-empty row with 0% and totals over the group', () => {
    expect(buildSplitsEditPayload([row('0')]).error).toMatch(/Row 1/);
    expect(buildSplitsEditPayload([row('60'), row('60')]).error).toMatch(/100%/);
  });
});

describe('setSplitGroupsOf encodes an empty reserved group', () => {
  const abi = [{
    type: 'function', name: 'setSplitGroupsOf', stateMutability: 'nonpayable', outputs: [],
    inputs: [
      { name: 'projectId', type: 'uint256' },
      { name: 'rulesetId', type: 'uint256' },
      { name: 'splitGroups', type: 'tuple[]', components: [
        { name: 'groupId', type: 'uint256' },
        { name: 'splits', type: 'tuple[]', components: [
          { name: 'percent', type: 'uint32' }, { name: 'projectId', type: 'uint64' }, { name: 'beneficiary', type: 'address' },
          { name: 'preferAddToBalance', type: 'bool' }, { name: 'lockedUntil', type: 'uint48' }, { name: 'hook', type: 'address' } ] },
      ] },
    ],
  }];

  it('round-trips a groups array whose splits list is empty', () => {
    const data = encodeFunctionData({ abi, functionName: 'setSplitGroupsOf', args: [5n, 7n, [{ groupId: 1n, splits: [] }]] });
    const dec = decodeFunctionData({ abi, data });
    expect(dec.args[2]).toHaveLength(1);
    expect(dec.args[2][0].splits).toHaveLength(0);
  });
});

describe('queue-ruleset flow accepts a 0% reserved rate end-to-end', () => {
  function queueState() {
    const s = __test.initState();
    s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth'];
    s.details.name = 'P'; s.details.owner = ALICE;
    s.stages[0].weight = '1000'; s.stages[0].durationSeconds = 0;
    return s;
  }

  it('no reserved recipient rows → metadata.reservedPercent encodes 0', () => {
    const s = queueState();
    s.stages[0].reservedRecipients = [];
    expect(buildQueueRulesetConfigs(s, 1, 0)[0].metadata.reservedPercent).toBe(0);
  });

  it('rows summing 40% encode 4000; deleting them returns the rate to 0', () => {
    const s = queueState();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: ALICE, projectId: 0, percent: 40 }];
    expect(buildQueueRulesetConfigs(s, 1, 0)[0].metadata.reservedPercent).toBe(4000);
    s.stages[0].reservedRecipients = [];
    expect(buildQueueRulesetConfigs(s, 1, 0)[0].metadata.reservedPercent).toBe(0);
  });

  it('validation never gates on having reserved recipients (only on totals OVER 100%)', () => {
    const s = queueState();
    s.stages[0].reservedRecipients = [];
    expect(__test.splitTotalIssue(s)).toBeNull();
    expect(__test.recipientIssue(s)).toBeNull();
  });
});

describe('reserved-splits editor UI (source contract)', () => {
  it('no longer refuses an empty recipients list', () => {
    expect(discoverSrc).not.toMatch(/Add at least one recipient/);
    expect(discoverSrc).toMatch(/buildSplitsEditPayload\(rows\)/);
  });

  it('explains owner accrual when clearing, and points at the queue flow for a true 0% rate', () => {
    expect(discoverSrc).toMatch(/reserved tokens will go to the project owner/);
    expect(discoverSrc).toMatch(/queue a new ruleset with a 0% reserved rate/);
  });
});
