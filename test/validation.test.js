// Validation / preflight tests: the deploy-time safety gates that stop a misconfigured project from
// shipping (funds to 0x0, splits over 100%, an unverified custom token). These are the guardrails that
// protect users from a confusing on-chain revert or a silent fund mis-route.
import { describe, it, expect } from 'vitest';
import { __test } from '../src/create-flow.js';

const { initState, recipientIssue, splitTotalIssue, applyAccountingDefaults, currentPayoutKinds, surplusTokenLabel, buildMetadata, lpHookIssue, deadlinePresetIssue, splitState, itemSplits } = __test;
const BOB = '0x2222222222222222222222222222222222222222';
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

function custom() {
  const s = initState();
  s.projectType = 'custom'; s.network = 'mainnet'; s.chainIds = [1]; s.accepts = ['eth'];
  return s;
}

describe('recipientIssue — blocks splits/payouts/auto-issuance with a value but no valid destination', () => {
  it('passes when there are no recipients', () => {
    expect(recipientIssue(custom())).toBeNull();
  });
  it('flags a reserved split with a percent but a blank address', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: '', percent: 10 }];
    expect(recipientIssue(s)).toMatch(/reserved-token split/i);
  });
  it('passes a reserved split with a valid address', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: BOB, percent: 10 }];
    expect(recipientIssue(s)).toBeNull();
  });
  it('flags a project-type split missing its project ID', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'project', projectId: 0, address: BOB, percent: 5 }];
    expect(recipientIssue(s)).toMatch(/project ID/i);
  });
  it('requires an explicit token beneficiary for project-pay and reserved project splits', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'project', projectId: 8, address: '', percent: 5 }];
    expect(recipientIssue(s)).toMatch(/receives.*tokens/i);
    s.stages[0].reservedRecipients = [];
    s.stages[0].payoutMode = 'unlimited';
    s.stages[0].payoutRecipients = [{ type: 'project', projectId: 8, address: '', percent: 100 }];
    expect(recipientIssue(s)).toMatch(/receives.*tokens/i);
  });
  it('allows project add-to-balance payouts without a token beneficiary', () => {
    const s = custom();
    s.stages[0].payoutMode = 'unlimited';
    s.stages[0].payoutRecipients = [{ type: 'project', projectId: 8, address: '', percent: 100, preferAddToBalance: true }];
    expect(recipientIssue(s)).toBeNull();
  });
  it('flags a custom-hook split with no valid hook address', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'customhook', hookAddress: '', percent: 5 }];
    expect(recipientIssue(s)).toMatch(/hook/i);
  });
  it('ignores an empty (zero-value) recipient row', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: '', percent: 0 }];
    expect(recipientIssue(s)).toBeNull();
  });
  it('flags an auto-issuance with a count but no recipient', () => {
    const s = custom();
    s.stages[0].autoIssuances = [{ count: '100', address: '' }];
    expect(recipientIssue(s)).toMatch(/auto-issuance/i);
  });
});

describe('project metadata', () => {
  it('persists operator-defined shop category names in the project URI', () => {
    expect(buildMetadata({ name: 'Shop' }, [{ id: 1, name: 'Bounties' }, { id: 2, name: 'Judges' }])).toMatchObject({
      storeCategories: { 1: 'Bounties', 2: 'Judges' },
    });
  });
});

describe('splitTotalIssue — blocks reserved/payout percentages over 100%', () => {
  it('passes at exactly 100%', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: BOB, percent: 60 }, { type: 'wallet', address: BOB, percent: 40 }];
    expect(splitTotalIssue(s)).toBeNull();
  });
  it('flags reserved splits totalling 120%', () => {
    const s = custom();
    s.stages[0].reservedRecipients = [{ type: 'wallet', address: BOB, percent: 60 }, { type: 'wallet', address: BOB, percent: 60 }];
    expect(splitTotalIssue(s)).toMatch(/over 100%/i);
  });
  it('flags percent-mode payout splits over 100%', () => {
    const s = custom();
    s.stages[0].payoutMode = 'unlimited';
    s.stages[0].payoutRecipients = [{ type: 'wallet', address: BOB, percent: 70 }, { type: 'wallet', address: BOB, percent: 70 }];
    expect(splitTotalIssue(s)).toMatch(/over 100%/i);
  });
});

describe('ETH+USDC base currency = USD(2) (audit H7 regression — else USDC payments revert)', () => {
  it('a custom project accepting ETH+USDC sets every base/store currency to USD(2)', () => {
    const s = custom();
    s.accepts = ['eth', 'usdc'];
    applyAccountingDefaults(s);
    expect(s.stages[0].baseCurrency).toBe(2);
    expect(s.stages[0].payoutCurrency).toBe(2);
    expect(s.storePricingCurrency).toBe(2);
  });
  it('a revnet accepting ETH+USDC sets revBaseCurrency to USD(2)', () => {
    const s = custom();
    s.projectType = 'revnet';
    s.accepts = ['eth', 'usdc'];
    applyAccountingDefaults(s);
    expect(s.revBaseCurrency).toBe(2);
  });
  it('pure ETH stays ETH(1)', () => {
    const s = custom();
    s.accepts = ['eth'];
    applyAccountingDefaults(s);
    expect(s.stages[0].baseCurrency).toBe(1);
  });
});

describe('custom-token accounting is exclusive and forces all currencies to itself', () => {
  it('applyAccountingDefaults sets every currency to the custom currency id', () => {
    const s = custom();
    s.accepts = ['custom'];
    s.customToken = { address: DAI, symbol: 'DAI', decimals: 18, status: 'ok' };
    applyAccountingDefaults(s);
    const cur = Number(BigInt(DAI) % (1n << 32n));
    expect(s.storePricingCurrency).toBe(cur);
    expect(s.stages[0].baseCurrency).toBe(cur);
    expect(s.stages[0].payoutCurrency).toBe(cur);
    expect(s.stages[0].surplusAllowanceCurrency).toBe(cur);
  });
  it('a custom token routes payouts through the per-token (multi-token) path', () => {
    const s = custom();
    s.accepts = ['custom'];
    s.customToken = { address: DAI, symbol: 'DAI', decimals: 18, status: 'ok' };
    const kinds = currentPayoutKinds(s);
    expect(kinds).toBeTruthy();
    expect(kinds).toHaveLength(1);
    expect(kinds[0].decimals).toBe(18);
    expect(kinds[0].symbol).toBe('DAI');
  });
  it('labels transaction reviews with the actual custom token', () => {
    const s = custom();
    s.accepts = ['custom'];
    s.customToken = { address: DAI, symbol: 'DAI', decimals: 18, status: 'ok' };
    expect(surplusTokenLabel(s)).toBe('DAI');
  });
});

describe('multi-token review labels', () => {
  it('shows both ETH and USDC instead of implying the first token is the only one', () => {
    const s = custom();
    s.accepts = ['eth', 'usdc'];
    expect(surplusTokenLabel(s)).toBe('ETH and USDC');
  });
});

// -- Immutable-deploy fail-closed gates: unmanifested hook deployments must BLOCK the deploy with a
// -- chain-naming validation error instead of silently encoding hook/approvalHook = address(0).

describe('lpHookIssue — Fund market split requires JBP6FeeLPSplitHook on every selected chain', () => {
  it('passes when no stage uses a Fund market split', () => {
    const s = custom();
    s.chainIds = [11155420]; // OP Sepolia — the known chain without the LP hook
    expect(lpHookIssue(s)).toBeNull();
  });
  it('passes when the hook exists on every selected chain', () => {
    const s = custom();
    s.chainIds = [1, 8453];
    s.stages[0].reservedRecipients = [{ type: 'lphook', percent: 10 }];
    expect(lpHookIssue(s)).toBeNull();
  });
  it('fails CLOSED, naming the chain, when the hook is unmanifested there', () => {
    const s = custom();
    s.network = 'testnet';
    s.chainIds = [11155111, 11155420];
    s.stages[0].reservedRecipients = [{ type: 'lphook', percent: 10 }];
    const issue = lpHookIssue(s);
    expect(issue).toMatch(/isn.t deployed on/i);
    expect(issue).toMatch(/OP Sepolia|11155420/);
    expect(issue).toMatch(/remove|deselect/i);
  });
});

describe('splitState — lphook encoder backstop', () => {
  it('throws (never falls through to a msg.sender-payable wallet split) when the hook is missing', () => {
    expect(() => splitState({ type: 'lphook' }, 100000000, null, 11155420)).toThrow(/isn.t deployed on/i);
  });
  it('still encodes the shared hook where it exists', () => {
    const sp = splitState({ type: 'lphook' }, 100000000, null, 1);
    expect(BigInt(sp.hook)).not.toBe(0n);
  });
});

describe('deadlinePresetIssue — preset approval hooks must exist on every selected chain', () => {
  it('passes when every selected chain has the preset deployment', () => {
    const s = custom();
    s.chainIds = [1, 8453];
    expect(deadlinePresetIssue(s)).toBeNull(); // default '1day' preset
  });
  it('fails CLOSED, naming the chain, when a preset deployment is missing', () => {
    const s = custom();
    s.chainIds = [1, 999999];
    const issue = deadlinePresetIssue(s);
    expect(issue).toMatch(/approval/i);
    expect(issue).toMatch(/999999/);
    expect(issue).toMatch(/different|deselect/i);
  });
  it('does not apply to "no deadline", custom addresses (approvalIssue covers those), or revnets', () => {
    const s = custom();
    s.chainIds = [1, 999999];
    s.stages[0].deadline = 'none';
    expect(deadlinePresetIssue(s)).toBeNull();
    s.stages[0].deadline = 'custom';
    expect(deadlinePresetIssue(s)).toBeNull();
    s.stages[0].deadline = '1day';
    s.projectType = 'revnet';
    expect(deadlinePresetIssue(s)).toBeNull();
  });
});

describe('itemSplits — per-row rounding must never sum above 1e9', () => {
  it('routes shares through fillSplits so three 1/3 rows sum to exactly 1e9', () => {
    const d = { splitOn: true, splitRecipients: [
      { pct: 1, recip: '0x2222222222222222222222222222222222222222' },
      { pct: 1, recip: '0x3333333333333333333333333333333333333333' },
      { pct: 1, recip: '0x4444444444444444444444444444444444444444' },
    ] };
    const sp = itemSplits(d, null, 1, 0);
    const sum = sp.splits.reduce((acc, x) => acc + x.percent, 0);
    expect(sum).toBe(1000000000);
  });
  it('keeps the untroubled two-row case intact', () => {
    const d = { splitOn: true, splitRecipients: [
      { pct: 60, recip: '0x2222222222222222222222222222222222222222' },
      { pct: 40, recip: '0x3333333333333333333333333333333333333333' },
    ] };
    const sp = itemSplits(d, null, 1, 0);
    expect(sp.splits.map(x => x.percent)).toEqual([600000000, 400000000]);
    expect(sp.splitPercent).toBe(1000000000);
  });
});
