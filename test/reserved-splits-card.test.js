// Reserved-splits card + editor. Confirmed onchain (kmac88's Base Sepolia projects): no splits are set
// on any ruleset and reservedPercent is 0 everywhere, yet the card rendered a bare owner address at
// "100%" and the editor refused every percentage. Each describe below pins one of those defects.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderSplitsInto,
  splitShareDisplay,
  buildSplitsEditPayload,
  splitsEditorTotalText,
  splitsEditorRulesetNotice,
  splitsClearGuard,
  createRulesetSplitsLoader,
} from '../src/discover.js';

const discoverSrc = readFileSync(resolve(process.cwd(), 'src/discover.js'), 'utf8');

const ZERO = '0x0000000000000000000000000000000000000000';
const OWNER = '0xA11ce00000000000000000000000000000000001';
const BOB = '0xB0b0000000000000000000000000000000000002';
const CAROL = '0xCa401000000000000000000000000000000000003'.slice(0, 42);

const project = { id: 5, chainId: 1, owner: OWNER, isRevnet: false };

function split(percent, beneficiary) {
  return { percent, projectId: 0, beneficiary: beneficiary || BOB, preferAddToBalance: false, lockedUntil: 0, hook: ZERO };
}
function box() { return document.createElement('div'); }
function rowsOf(node) { return Array.from(node.querySelectorAll('.detail-ruleset-row')); }

// ---------------------------------------------------------------------------
// DEFECT 1 — an unconfigured group must not be drawn as a configured recipient.
// ---------------------------------------------------------------------------
describe('DEFECT 1 — empty split group renders prose, never a synthesized 100% row', () => {
  it('reserved: no rows, prose naming the owner, no fabricated percentage', () => {
    const b = box();
    renderSplitsInto(b, [], { project, chainId: 1, kind: 'reserved', limitPct: 0 });
    expect(rowsOf(b)).toHaveLength(0);
    expect(b.textContent).toMatch(/No reserved recipients/);
    expect(b.textContent).toMatch(/go to the project owner/);
    expect(b.textContent).not.toMatch(/100%/);
    // The owner address is still shown — as prose, not as a recipient row.
    expect(b.querySelector('.detail-address')).toBeTruthy();
  });

  it('reserved: a null splits read is treated the same as an empty one', () => {
    const b = box();
    renderSplitsInto(b, null, { project, chainId: 1, kind: 'reserved', limitPct: 2.5 });
    expect(rowsOf(b)).toHaveLength(0);
    expect(b.textContent).toMatch(/No reserved recipients/);
  });

  it('payout: empty group also renders prose', () => {
    const b = box();
    renderSplitsInto(b, [], { project, chainId: 1, kind: 'payout', limitPct: 100 });
    expect(rowsOf(b)).toHaveLength(0);
    expect(b.textContent).toMatch(/No payout recipients/);
    expect(b.textContent).not.toMatch(/100%/);
  });

  it('owner unknown → prose still renders, without an address node', () => {
    const b = box();
    renderSplitsInto(b, [], { project: { id: 5, chainId: 1 }, chainId: 1, kind: 'reserved', limitPct: 0 });
    expect(rowsOf(b)).toHaveLength(0);
    expect(b.querySelector('.detail-address')).toBeNull();
  });

  it('a leftover row survives only when the group HAS recipients', () => {
    const b = box();
    renderSplitsInto(b, [split(400000000)], { project, chainId: 1, kind: 'reserved', limitPct: 10 });
    const rows = rowsOf(b);
    expect(rows).toHaveLength(2); // recipient + leftover
    // The leftover keeps the "Project owner" label BESIDE the address, never instead of it.
    expect(rows[1].textContent).toMatch(/Project owner/);
    expect(rows[1].querySelector('.detail-address')).toBeTruthy();
  });

  it('a fully allocated group has no leftover row at all', () => {
    const b = box();
    renderSplitsInto(b, [split(600000000), split(400000000, CAROL)], { project, chainId: 1, kind: 'reserved', limitPct: 10 });
    expect(rowsOf(b)).toHaveLength(2);
    expect(b.textContent).not.toMatch(/Project owner/);
  });

  it('a revnet labels the leftover REVOwner', () => {
    const b = box();
    renderSplitsInto(b, [split(400000000)], { project: { id: 5, chainId: 1, owner: OWNER, isRevnet: true }, chainId: 1, kind: 'reserved', limitPct: 10 });
    expect(rowsOf(b)[1].textContent).toMatch(/REVOwner/);
  });

  it('the payouts card no longer replaces the owner label with a bare address', () => {
    // The funds-card payouts table builds its owner row inline; it must append the address, not wipe the label.
    expect(discoverSrc).not.toMatch(/ownerName\.innerHTML = ''/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — a row shows the issuance share AND its share of the group.
// ---------------------------------------------------------------------------
describe('DEFECT 3 — per-row percentages show issuance share with a group-share companion', () => {
  it('splitShareDisplay converts a 1e9 share against the reserved rate', () => {
    const d = splitShareDisplay(500000000, 10);
    expect(d.groupPct).toBeCloseTo(50, 9);
    expect(d.issuancePct).toBeCloseTo(5, 9);
    expect(d.showCompanion).toBe(true);
    expect(d.primaryText).toBe('5%');
    expect(d.companionText).toBe('50% of limit');
  });

  it('a 100% limit (payouts) has no companion — both numbers are the same', () => {
    const d = splitShareDisplay(500000000, 100);
    expect(d.issuancePct).toBeCloseTo(50, 9);
    expect(d.showCompanion).toBe(false);
  });

  it('rendered reserved rows carry both numbers', () => {
    const b = box();
    renderSplitsInto(b, [split(500000000)], { project, chainId: 1, kind: 'reserved', limitPct: 10 });
    const first = rowsOf(b)[0];
    expect(first.textContent).toMatch(/5%/);
    expect(first.textContent).toMatch(/\(50% of limit\)/);
  });

  it('rendered payout rows carry one number', () => {
    const b = box();
    renderSplitsInto(b, [split(500000000)], { project, chainId: 1, kind: 'payout', limitPct: 100 });
    expect(rowsOf(b)[0].textContent).toMatch(/50%/);
    expect(b.textContent).not.toMatch(/of limit/);
  });

  it('reservedPercent 0 → rows read 0% of issuance and the section says so', () => {
    const b = box();
    renderSplitsInto(b, [split(1000000000)], { project, chainId: 1, kind: 'reserved', limitPct: 0 });
    const first = rowsOf(b)[0];
    expect(first.textContent).toMatch(/0%/);
    expect(first.textContent).toMatch(/\(100% of limit\)/);
    expect(b.textContent).toMatch(/reserves 0%/);
  });

  it('no zero-rate note when the ruleset actually reserves something', () => {
    const b = box();
    renderSplitsInto(b, [split(1000000000)], { project, chainId: 1, kind: 'reserved', limitPct: 2.5 });
    expect(b.textContent).not.toMatch(/reserves 0%/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — the editor speaks GROUP SHARE, so a 0% reserved rate is not a dead end.
// ---------------------------------------------------------------------------
describe('DEFECT 2 — group-share editor accepts recipients while the reserved rate is 0', () => {
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

  it('a single 100% row is the whole group', () => {
    const out = buildSplitsEditPayload([row('100')]);
    expect(out.error).toBeUndefined();
    expect(out.splits[0].percent).toBe(1000000000);
    expect(out.sumPct).toBe(100);
  });

  it('rows summing to 100 split the group — no reserved rate involved', () => {
    const out = buildSplitsEditPayload([row('60'), row('40')]);
    expect(out.error).toBeUndefined();
    expect(out.splits.map(s => s.percent)).toEqual([600000000, 400000000]);
  });

  it('over 100% of the group is rejected', () => {
    expect(buildSplitsEditPayload([row('60'), row('60')]).error).toMatch(/100%/);
  });

  it('an empty group is still a valid submission', () => {
    expect(buildSplitsEditPayload([])).toEqual({ splits: [], sumPct: 0 });
  });

  it('takes no limit argument at all — the 0-limit dead end is gone', () => {
    expect(buildSplitsEditPayload.length).toBe(1);
    expect(discoverSrc).not.toMatch(/pct \/ limitPct \* 1e9/);
  });

  it('total line reports the group share, with issuance derived read-only', () => {
    const zero = splitsEditorTotalText({ sumPct: 100, reservedRatePct: 0, isReserved: true });
    expect(zero.error).toBe(false);
    expect(zero.text).toMatch(/Total: 100% of the group/);
    expect(zero.text).not.toMatch(/of 0% limit/);

    const rated = splitsEditorTotalText({ sumPct: 100, reservedRatePct: 2.5, isReserved: true });
    expect(rated.text).toMatch(/= 2\.5% of issuance/);

    const partial = splitsEditorTotalText({ sumPct: 40, reservedRatePct: 2.5, isReserved: true });
    expect(partial.text).toMatch(/= 1% of issuance/);
    expect(partial.text).toMatch(/remaining 60% goes to the project owner/);
  });

  it('over-allocation is an error line', () => {
    const over = splitsEditorTotalText({ sumPct: 101, reservedRatePct: 2.5, isReserved: true });
    expect(over.error).toBe(true);
    expect(over.text).toMatch(/can’t exceed 100%/);
  });

  it('payout groups get no issuance clause', () => {
    const p = splitsEditorTotalText({ sumPct: 100, reservedRatePct: null, isReserved: false });
    expect(p.text).toMatch(/Total: 100% of the group/);
    expect(p.text).not.toMatch(/issuance/);
  });

  it('the editor keeps the queue-ruleset deep link when the rate is 0', () => {
    expect(discoverSrc).toMatch(/receive nothing until a ruleset reserves tokens/);
    expect(discoverSrc).toMatch(/openQueueRulesetModal\(project\)/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 4 — per-chain reads must use the SELECTED chain, not the home chain.
// ---------------------------------------------------------------------------
describe('DEFECT 4 — splits loader reads the selected chain', () => {
  const TOKEN_A = '0x1111111111111111111111111111111111111111';
  const TOKEN_B = '0x2222222222222222222222222222222222222222';
  const multichain = { id: 5, chainId: 1, idByChain: { 1: 5, 8453: 77 } };

  function loaderWithSpy() {
    const calls = [];
    const loader = createRulesetSplitsLoader(multichain, {
      read: (chainId, contract, abi, fn, args) => { calls.push({ chainId, contract, fn, args }); return Promise.resolve([]); },
      getAddress: () => '0x9999999999999999999999999999999999999999',
    });
    return { loader, calls };
  }

  it('reserved splits read the selected chain with THAT chain project id', async () => {
    const { loader, calls } = loaderWithSpy();
    await loader.reserved(8453, 42);
    expect(calls).toHaveLength(1);
    expect(calls[0].chainId).toBe(8453);
    expect(calls[0].args[0]).toBe(77n);
    expect(calls[0].args[1]).toBe(42n);
  });

  it('the cache is keyed by chain AND ruleset — chains never share a result', async () => {
    const { loader, calls } = loaderWithSpy();
    await loader.reserved(8453, 42);
    await loader.reserved(1, 42);
    expect(calls.map(c => c.chainId)).toEqual([8453, 1]);
    expect(calls.map(c => c.args[0])).toEqual([77n, 5n]);
    await loader.reserved(8453, 42); // cached
    expect(calls).toHaveLength(2);
    await loader.reserved(8453, 43); // different ruleset
    expect(calls).toHaveLength(3);
  });

  it('funds access reads the selected chain for limits, allowances AND payout splits', async () => {
    const { loader, calls } = loaderWithSpy();
    const kind = { key: 'usdc', symbol: 'USDC', decimals: 6, addrForChain: cid => (cid === 8453 ? TOKEN_B : TOKEN_A) };
    const fa = await loader.fundsAccess(8453, 42, kind);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.chainId === 8453)).toBe(true);
    expect(calls.every(c => c.args[0] === 77n)).toBe(true);
    expect(fa.payoutGroupId).toBe(BigInt(TOKEN_B));
    expect(fa.payout).toBe('None');
  });

  it('an unknown chain rejects rather than silently reading the home chain', async () => {
    const { loader } = loaderWithSpy();
    await expect(loader.reserved(999, 42)).rejects.toThrow();
  });

  it('the ruleset card no longer captures a single home chain for its reads', () => {
    expect(discoverSrc).not.toMatch(/var faHome = project\.chainId/);
    expect(discoverSrc).not.toMatch(/var faPid = pidOn\(project, project\.chainId\)/);
  });
});

// ---------------------------------------------------------------------------
// Split routing precedence — the hook comes FIRST, mirroring the contracts.
// JBController.sendReservedTokensToSplitsOf and JBMultiTerminal.executePayout
// both route 100% of a split to its hook when one is set, regardless of any
// projectId/beneficiary also on the split.
// ---------------------------------------------------------------------------
describe('split routing precedence — a hook split renders as a hook even with projectId/beneficiary set', () => {
  const HOOK = '0xD00d000000000000000000000000000000000004';
  function hookSplit(over) {
    return Object.assign({ percent: 1000000000, projectId: 0, beneficiary: ZERO, preferAddToBalance: false, lockedUntil: 0, hook: HOOK }, over || {});
  }

  it('reserved: hook + projectId renders the hook, never "Pay project #N"', () => {
    const b = box();
    renderSplitsInto(b, [hookSplit({ projectId: 7 })], { project, chainId: 1, kind: 'reserved', limitPct: 10 });
    expect(b.textContent).toMatch(/Split hook/);
    expect(b.querySelector('.split-project-link')).toBeNull();
    expect(b.textContent).not.toMatch(/Project #7/);
  });

  it('payout: hook + beneficiary renders the hook, not a bare recipient address', () => {
    const b = box();
    renderSplitsInto(b, [hookSplit({ beneficiary: BOB })], { project, chainId: 1, kind: 'payout', limitPct: 100 });
    expect(b.textContent).toMatch(/Split hook/);
    expect(b.textContent).not.toMatch(/Pay project/);
  });

  it('a hook-only split still renders the hook, not the owner fallback', () => {
    const b = box();
    renderSplitsInto(b, [hookSplit()], { project, chainId: 1, kind: 'reserved', limitPct: 10 });
    expect(rowsOf(b)[0].textContent).toMatch(/Split hook/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 5 — the editor names the ruleset it verified.
// ---------------------------------------------------------------------------
describe('DEFECT 5 — the editor is honest about which ruleset it edits', () => {
  it('matching ids just name the ruleset and cycle', () => {
    const n = splitsEditorRulesetNotice({ id: '7', cycleNumber: 3 }, { id: '7', cycleNumber: 3 });
    expect(n.mismatch).toBe(false);
    expect(n.text).toMatch(/ruleset #7/);
    expect(n.text).toMatch(/cycle #3/);
  });

  it('a different current ruleset than the card displayed is called out', () => {
    const n = splitsEditorRulesetNotice({ id: '9', cycleNumber: 4 }, { id: '7', cycleNumber: 3 });
    expect(n.mismatch).toBe(true);
    expect(n.text).toMatch(/#9/);
    expect(n.text).toMatch(/#7/);
    expect(n.text).toMatch(/different ruleset/i);
  });

  it('no displayed ruleset to compare against is not a mismatch', () => {
    const n = splitsEditorRulesetNotice({ id: '9', cycleNumber: 4 }, null);
    expect(n.mismatch).toBe(false);
    expect(n.text).toMatch(/#9/);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 6 — clearing a group only reaches the owner when the fallback is empty.
// ---------------------------------------------------------------------------
describe('DEFECT 6 — clearing is blocked when JBSplits would serve the fallback group', () => {
  it('not clearing → never blocked', () => {
    expect(splitsClearGuard({ clearing: false, fallbackSplits: [split(1000000000)], chainName: 'Base' })).toBeNull();
  });

  it('clearing with an empty fallback is allowed', () => {
    expect(splitsClearGuard({ clearing: true, fallbackSplits: [], chainName: 'Base' })).toBeNull();
  });

  it('clearing with a non-empty fallback is blocked, and says how many recipients', () => {
    const msg = splitsClearGuard({ clearing: true, fallbackSplits: [split(600000000), split(400000000)], chainName: 'Base' });
    expect(msg).toMatch(/2 default/);
    expect(msg).toMatch(/Base/);
  });

  it('a failed fallback read fails CLOSED', () => {
    const msg = splitsClearGuard({ clearing: true, fallbackReadFailed: true, chainName: 'Base' });
    expect(msg).toMatch(/Could not verify/);
    expect(msg).toMatch(/Base/);
  });

  it('the submit path reads the fallback ruleset group (id 0) per chain', () => {
    expect(discoverSrc).toMatch(/FALLBACK_RULESET_ID/);
    expect(discoverSrc).toMatch(/splitsClearGuard\(/);
  });
});
