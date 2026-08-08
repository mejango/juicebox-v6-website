import { parseEther } from 'viem';
import { addrOrZero } from './component-base.js';

export var UINT112_MAX = (1n << 112n) - 1n;

export var DURATION_PRESETS = [
  { label: 'None (no expiry)', seconds: 0 },
  { label: '1 day', seconds: 86400 },
  { label: '3 days', seconds: 259200 },
  { label: '7 days', seconds: 604800 },
  { label: '14 days', seconds: 1209600 },
  { label: '28 days', seconds: 2419200 },
  { label: '30 days', seconds: 2592000 },
  { label: '90 days', seconds: 7776000 },
  { label: '365 days', seconds: 31536000 },
  { label: 'Custom', seconds: -1 },
];

// Blank in the default (queue) mode = inherit the previous ruleset's (cut) weight, which JBRulesets
// encodes as the RAW sentinel weight 1. That sentinel only inherits when a PREVIOUS ruleset exists —
// at launch JBRulesets stores the 1 as-is (≈1 wei-token per base unit, effectively dust issuance),
// so the launch widget passes mode 'launch' where blank encodes an explicit 0n (no issuance). Any
// typed number is 18-dec fixed-point tokens per base unit — "1" means 1e18, "0" means no issuance.
// Non-blank input that doesn't parse as a plain decimal ("1,000", "10e3") THROWS so an operator's typo
// can't silently encode zero issuance into an irreversible queued/launched ruleset — matching the
// fund-access builder, whose BigInt() also throws on garbage. Negative input degrades to 0n.
export function parseRulesetWeight(value, mode) {
  if (value == null || String(value).trim() === '') return mode === 'launch' ? 0n : 1n;
  var weight;
  try {
    weight = parseEther(String(value).trim());
  } catch (_) {
    throw new Error('Invalid issuance weight "' + String(value).trim() + '" — enter a plain decimal number of tokens (no commas, spaces, or exponents), or leave the field blank.');
  }
  if (weight < 0n) return 0n;
  return weight > UINT112_MAX ? UINT112_MAX : weight;
}

export function createDefaultSplit() {
  return { preferAddToBalance: false, percent: '', projectId: '', beneficiary: '', lockedUntil: '', hook: '' };
}

export function createDefaultSplitGroup() {
  return { groupId: '', splits: [createDefaultSplit()] };
}

export function createDefaultPayoutLimit() {
  return { amount: '', currency: 1 };
}

export function createDefaultSurplusAllowance() {
  return { amount: '', currency: 1 };
}

export function createDefaultFundAccessLimitGroup() {
  return { terminal: '', token: '', payoutLimits: [createDefaultPayoutLimit()], surplusAllowances: [createDefaultSurplusAllowance()] };
}

export function createDefaultRuleset(opts) {
  opts = opts || {};
  return {
    mustStartAtOrAfter: opts.mustStartAtOrAfter != null ? opts.mustStartAtOrAfter : 0,
    durationPreset: 0,
    durationCustom: '',
    weight: opts.weight != null ? opts.weight : '1000000',
    weightCutPercent: 0,
    reservedPercent: 0,
    cashOutTaxRate: 0,
    baseCurrency: 1,
    pausePay: false,
    pauseCreditTransfers: false,
    allowOwnerMinting: false,
    allowSetCustomToken: true,
    allowTerminalMigration: false,
    allowSetTerminals: true,
    allowSetController: true,
    allowAddAccountingContext: true,
    allowAddPriceFeed: false,
    ownerMustSendPayouts: false,
    holdFees: false,
    // UI-space flag: checked = cash outs draw on the omnichain (total) surplus. Inverted into the
    // on-chain `scopeCashOutsToLocalBalances` bit at the encode boundary in buildRulesetConfigs.
    useTotalSurplusForCashOuts: true,
    useDataHookForPay: false,
    useDataHookForCashOut: false,
    approvalHook: '',
    dataHook: '',
    metadataExtra: '0',
    splitGroups: [],
    fundAccessLimitGroups: [],
    flagsExpanded: false,
    splitsExpanded: false,
    fundAccessExpanded: false,
    advancedExpanded: false,
  };
}

export function getDurationSeconds(rs) {
  if (rs.durationPreset === -1) return Number(rs.durationCustom) || 0;
  return rs.durationPreset;
}

export function buildRulesetConfigs(rulesets, opts) {
  opts = opts || {};
  var payDataHook = !!opts.payDataHookVariant;
  var configs = [];
  for (var i = 0; i < rulesets.length; i++) {
    var rs = rulesets[i];
    var meta = {
      reservedPercent: Math.round(rs.reservedPercent * 100),
      cashOutTaxRate: Math.round(rs.cashOutTaxRate * 100),
      baseCurrency: rs.baseCurrency,
      pausePay: rs.pausePay,
      pauseCreditTransfers: rs.pauseCreditTransfers,
      allowOwnerMinting: rs.allowOwnerMinting,
      allowSetCustomToken: rs.allowSetCustomToken,
      allowTerminalMigration: rs.allowTerminalMigration,
      allowSetTerminals: rs.allowSetTerminals,
      allowSetController: rs.allowSetController,
      allowAddAccountingContext: rs.allowAddAccountingContext,
      allowAddPriceFeed: rs.allowAddPriceFeed,
      ownerMustSendPayouts: rs.ownerMustSendPayouts,
      holdFees: rs.holdFees,
    };
    // "Use total surplus for cash outs" (UI) is the INVERSE of the on-chain bit: JBRulesetMetadata's
    // `scopeCashOutsToLocalBalances` = true restricts cash outs to THIS chain's balances.
    if (payDataHook) {
      meta.scopeCashOutsToLocalBalances = !rs.useTotalSurplusForCashOuts;
      meta.useDataHookForCashOut = !!rs.useDataHookForCashOut;
      meta.metadata = Number(rs.metadataExtra) || 0;
    } else {
      meta.scopeCashOutsToLocalBalances = !rs.useTotalSurplusForCashOuts;
      meta.useDataHookForPay = !!rs.useDataHookForPay;
      meta.useDataHookForCashOut = !!rs.useDataHookForCashOut;
      meta.dataHook = addrOrZero(rs.dataHook);
      meta.metadata = Number(rs.metadataExtra) || 0;
    }
    configs.push({
      mustStartAtOrAfter: BigInt(rs.mustStartAtOrAfter || 0),
      duration: getDurationSeconds(rs),
      weight: parseRulesetWeight(rs.weight, opts.weightMode),
      weightCutPercent: Math.round(rs.weightCutPercent * 10000000),
      approvalHook: addrOrZero(rs.approvalHook),
      metadata: meta,
      splitGroups: buildSplitGroups(rs.splitGroups),
      fundAccessLimitGroups: buildFundAccessLimitGroups(rs.fundAccessLimitGroups),
    });
  }
  return configs;
}

export function buildSplitGroups(groups) {
  var result = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g.groupId) continue;
    var splits = [];
    for (var j = 0; j < g.splits.length; j++) {
      var s = g.splits[j];
      var percent = Number(s.percent) || 0;
      if (percent <= 0) continue;
      splits.push({
        preferAddToBalance: s.preferAddToBalance,
        percent: percent,
        projectId: Number(s.projectId) || 0,
        beneficiary: addrOrZero(s.beneficiary),
        lockedUntil: Number(s.lockedUntil) || 0,
        hook: addrOrZero(s.hook),
      });
    }
    if (splits.length > 0) result.push({ groupId: BigInt(g.groupId), splits: splits });
  }
  return result;
}

export function buildFundAccessLimitGroups(groups) {
  var result = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    if (!g.terminal) continue;
    var payoutLimits = [];
    for (var j = 0; j < g.payoutLimits.length; j++) {
      var pl = g.payoutLimits[j];
      if (!pl.amount && pl.amount !== '0') continue;
      payoutLimits.push({ amount: BigInt(pl.amount), currency: Number(pl.currency) || 0 });
    }
    var surplusAllowances = [];
    for (var k = 0; k < g.surplusAllowances.length; k++) {
      var sa = g.surplusAllowances[k];
      if (!sa.amount && sa.amount !== '0') continue;
      surplusAllowances.push({ amount: BigInt(sa.amount), currency: Number(sa.currency) || 0 });
    }
    result.push({
      terminal: g.terminal,
      token: addrOrZero(g.token),
      payoutLimits: payoutLimits,
      surplusAllowances: surplusAllowances,
    });
  }
  return result;
}
