// Tests for the ruleset approval condition (preset deadline | custom approval-hook address, per-chain)
// and per-split locks (JBSplit.lockedUntil). These touch the on-chain ruleset/split encoding, so a wrong
// approvalHook address or a mis-encoded lock timestamp is a real correctness bug.
import { describe, it, expect } from 'vitest';
import { __test } from '../src/create-flow.js';
import { getAddress, ZERO_ADDRESS } from '../src/component-base.js';

const { initState, assembleRuleset, splitState, splitLockAllowed, tsToDateInput, FOREVER_SECONDS, pcAddrSet, approvalIssue } = __test;
const BOB = '0x2222222222222222222222222222222222222222';

const ALICE = '0x1111111111111111111111111111111111111111';
const HOOK_A = '0x000000000000000000000000000000000000AAaA';
const HOOK_B = '0x000000000000000000000000000000000000bBBb';

function baseState() {
  const s = initState();
  s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth'];
  s.details = Object.assign(s.details, { name: 'Test', owner: ALICE });
  s.stages[0].weight = '1000';
  s.stages[0].durationSeconds = 2592000; // 30d so the approval condition + lock both apply
  return s;
}

describe('ruleset approval condition → rs.approvalHook', () => {
  it('preset deadline resolves to the registered approval-hook contract for the chain', () => {
    const s = baseState();
    s.stages.forEach((st) => { st.deadline = '1day'; });
    const rs = assembleRuleset(s, s.stages[0], 0, 1, true, true, 0);
    expect(rs.approvalHook).toBe(getAddress('JBDeadline1Day', 1) || ZERO_ADDRESS);
  });
  it('custom address uses the user-supplied approval hook', () => {
    const s = baseState();
    s.stages.forEach((st) => { st.deadline = 'custom'; });
    s.approvalAddress = HOOK_A;
    const rs = assembleRuleset(s, s.stages[0], 0, 1, true, true, 0);
    expect(rs.approvalHook.toLowerCase()).toBe(HOOK_A.toLowerCase());
  });
  it('custom address honors a per-chain override (multichain)', () => {
    const s = baseState();
    s.chainIds = [1, 10];
    s.stages.forEach((st) => { st.deadline = 'custom'; });
    s.approvalAddress = HOOK_A;
    pcAddrSet(s, 10, 'approval', HOOK_B); // chain 10 uses a different hook
    expect(assembleRuleset(s, s.stages[0], 0, 1, true, true, 0).approvalHook.toLowerCase()).toBe(HOOK_A.toLowerCase());
    expect(assembleRuleset(s, s.stages[0], 0, 10, true, true, 0).approvalHook.toLowerCase()).toBe(HOOK_B.toLowerCase());
  });
  it('custom address with no value → ZERO (never garbage)', () => {
    const s = baseState();
    s.stages.forEach((st) => { st.deadline = 'custom'; });
    s.approvalAddress = '';
    expect(BigInt(assembleRuleset(s, s.stages[0], 0, 1, true, true, 0).approvalHook)).toBe(0n);
  });
  it('deadlineOn=false forces approvalHook to ZERO regardless of selection', () => {
    const s = baseState();
    s.stages.forEach((st) => { st.deadline = 'custom'; });
    s.approvalAddress = HOOK_A;
    expect(BigInt(assembleRuleset(s, s.stages[0], 0, 1, true, false, 0).approvalHook)).toBe(0n);
  });
});

describe('split lock → JBSplit.lockedUntil', () => {
  it('a recipient lockedUntil timestamp encodes onto the split', () => {
    const ts = 1893456000; // 2030-01-01
    const sp = splitState({ type: 'wallet', address: ALICE, lockedUntil: ts }, 1, ALICE, 1);
    expect(sp.lockedUntil).toBe(ts);
  });
  it('no lock → lockedUntil 0', () => {
    expect(splitState({ type: 'wallet', address: ALICE }, 1, ALICE, 1).lockedUntil).toBe(0);
  });
});

describe('splitLockAllowed — lock control hidden for a Flexible (no-duration) ruleset', () => {
  it('fixed duration → allowed', () => {
    expect(splitLockAllowed({ durationSeconds: 2592000 })).toBe(true);
  });
  it('Forever (uint32 max) → allowed', () => {
    expect(splitLockAllowed({ durationSeconds: FOREVER_SECONDS })).toBe(true);
  });
  it('Flexible (0) / missing → not allowed', () => {
    expect(splitLockAllowed({ durationSeconds: 0 })).toBe(false);
    expect(splitLockAllowed({})).toBe(false);
    expect(splitLockAllowed(null)).toBe(false);
  });
});

describe('store redemptions — rs.useDataHookForCashOut (was hardcoded false for custom projects)', () => {
  it('off by default (no store)', () => {
    const s = baseState();
    expect(assembleRuleset(s, s.stages[0], 0, 1, true, true, 0).useDataHookForCashOut).toBe(false);
  });
  it('on when a store item is on this chain AND the project opted in', () => {
    const s = baseState();
    s.shopEnabled = true; s.nfts = [{}];
    s.collection.useForRedemptions = true;
    expect(assembleRuleset(s, s.stages[0], 0, 1, true, true, 0).useDataHookForCashOut).toBe(true);
  });
  it('off when opted in but no store is deployed (no data hook to call)', () => {
    const s = baseState();
    s.collection.useForRedemptions = true; // shopEnabled stays false
    expect(assembleRuleset(s, s.stages[0], 0, 1, true, true, 0).useDataHookForCashOut).toBe(false);
  });
});

describe('tsToDateInput — unix seconds → YYYY-MM-DD for the date picker', () => {
  it('round-trips a known date', () => {
    localStorage.setItem('jb-time-zone', 'UTC');
    expect(tsToDateInput(1893456000)).toBe('2030-01-01');
    localStorage.removeItem('jb-time-zone');
  });
});

describe('approvalIssue — deploy gate blocks a custom approval with no valid hook (audit M-1/L-1)', () => {
  it('null when no stage uses a custom condition', () => {
    const s = baseState(); s.stages.forEach((st) => { st.deadline = '1day'; });
    expect(approvalIssue(s)).toBeNull();
  });
  it('flags a custom condition with a blank address (would silently encode address(0))', () => {
    const s = baseState(); s.stages.forEach((st) => { st.deadline = 'custom'; }); s.approvalAddress = '';
    expect(approvalIssue(s)).toMatch(/valid contract address/i);
  });
  it('null when the custom address is a valid 0x', () => {
    const s = baseState(); s.stages.forEach((st) => { st.deadline = 'custom'; }); s.approvalAddress = HOOK_A;
    expect(approvalIssue(s)).toBeNull();
  });
  it('flags when a per-chain override is missing on one of several chains', () => {
    const s = baseState(); s.chainIds = [1, 10]; s.stages.forEach((st) => { st.deadline = 'custom'; }); s.approvalAddress = '';
    pcAddrSet(s, 1, 'approval', HOOK_A); // only chain 1 set → chain 10 still blank
    expect(approvalIssue(s)).toMatch(/valid contract address/i);
  });
});

describe('split lock encode-gating (audit L-3/L-4 — stale lock must not reach the chain)', () => {
  const locked = { type: 'wallet', address: ALICE, lockedUntil: 1893456000 };
  it('allowLock=false zeroes lockedUntil even when set (Flexible / revnet stage)', () => {
    expect(splitState(locked, 1, ALICE, 1, null, false).lockedUntil).toBe(0);
  });
  it('allowLock=true keeps it', () => {
    expect(splitState(locked, 1, ALICE, 1, null, true).lockedUntil).toBe(1893456000);
  });
  it('omitted allowLock keeps it (back-compat for direct callers)', () => {
    expect(splitState(locked, 1, ALICE, 1).lockedUntil).toBe(1893456000);
  });
  it('assembleRuleset gates a Flexible stage’s split lock to 0', () => {
    const s = baseState(); s.stages[0].durationSeconds = 0; // Flexible
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: BOB, percent: 50, lockedUntil: 1893456000 }];
    const rs = assembleRuleset(s, s.stages[0], 0, 1, true, true, 0);
    const sp = (rs.splitGroups || []).flatMap((g) => g.splits || []).find((x) => x.beneficiary.toLowerCase() === BOB.toLowerCase());
    expect(sp.lockedUntil).toBe(0);
  });
  it('assembleRuleset keeps the lock for a fixed-duration stage', () => {
    const s = baseState(); s.stages[0].durationSeconds = 2592000;
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: BOB, percent: 50, lockedUntil: 1893456000 }];
    const rs = assembleRuleset(s, s.stages[0], 0, 1, true, true, 0);
    const sp = (rs.splitGroups || []).flatMap((g) => g.splits || []).find((x) => x.beneficiary.toLowerCase() === BOB.toLowerCase());
    expect(sp.lockedUntil).toBe(1893456000);
  });
});
