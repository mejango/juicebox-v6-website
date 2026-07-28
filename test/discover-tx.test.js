// Transaction arg-builders extracted from discover.js (loans + cross-chain move). Separate file so the heavy
// discover.js import is isolated. Each builder is round-tripped through its contract ABI + arg-checked.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData, parseEther } from 'viem';
import { NATIVE_TOKEN } from '../src/component-base.js';
import { accountingTokenUsdValueAtPrice, borrowCurrencyForAccountContext, borrowLoanTokenForAccountContext, borrowMinAmountFromPreview, buildBorrowArgs, buildRepayArgs, buildSuckerPrepareArgs, buildSuckerToRemoteArgs, buildClaimTokensArgs, clearLightEdgeMatte, gossipAccountingStaleness, indexedActivityAmount, issuancePriceScaleMax, issuancePriceScaleRatio, loanOpeningAmounts, loanUnlockFeeText, ownersChartTotalLabel, priceChartTimeBounds, projectIdsByChainFromSuckerGroup, quotedOutputFloor, rawAccountingBalanceSummary, remainingAccessAmount, sourceTokenMeta, tokenCurrencyIdForAccounting, updateFundsTabBalance, BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY } from '../src/discover.js';
import { buildQueueRulesetsArgs, queueRulesetsAbi } from '../src/queue-ruleset-component.js';
import { buildFundAccessLimitGroups, buildRulesetConfigs, buildSplitGroups, createDefaultFundAccessLimitGroup, createDefaultRuleset, parseRulesetWeight } from '../src/launch-component.js';

const BOB = '0x2222222222222222222222222222222222222222';
const LOANS = '0x4444444444444444444444444444444444444444';
const SUCKER = '0x5555555555555555555555555555555555555555';
const ZERO = '0x0000000000000000000000000000000000000000';
const UINT112_MAX = (1n << 112n) - 1n;
const BEN32 = '0x000000000000000000000000' + '2222222222222222222222222222222222222222'; // bytes32-padded BOB
const META32 = '0x' + '00'.repeat(32);
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const roundTrips = (abi, fn, args) => decodeFunctionData({ abi, data: encodeFunctionData({ abi, functionName: fn, args }) }).args.length === args.length;
const defaultRulesetMetadata = {
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
  scopeCashOutsToLocalBalances: false,
  useDataHookForPay: false,
  useDataHookForCashOut: false,
  dataHook: ZERO,
  metadata: 0,
};

describe('cross-chain gossip freshness', () => {
  it('compares each accounting context instead of summing incompatible raw units', () => {
    const peer = { _viewChainId: 1, supply: 10n, balances: [
      { token: NATIVE_TOKEN, decimals: 18, balance: 100n },
      { token: USDC, decimals: 6, balance: 50n },
    ] };
    const actual = { id: 1, gossipSupply: 10n, gossipVerified: true, gossipTokens: [
      { token: NATIVE_TOKEN, decimals: 18, balance: 50n },
      { token: USDC, decimals: 6, balance: 100n },
    ] };
    // Both sides sum to 150 raw units, but each real asset is 50% stale.
    expect(gossipAccountingStaleness(peer, actual)).toEqual({ level: 'danger', label: '50% stale', pct: 0.5 });
  });

  it('reports sub-threshold drift as a green percentage', () => {
    const peer = { _viewChainId: 1, supply: 1000n, balances: [{ token: NATIVE_TOKEN, decimals: 18, balance: 989n }] };
    const actual = { id: 1, gossipSupply: 1000n, gossipVerified: true, gossipTokens: [
      { token: NATIVE_TOKEN, decimals: 18, balance: 1000n },
    ] };
    expect(gossipAccountingStaleness(peer, actual)).toEqual({ level: 'slight', label: '1.1% stale', pct: 0.011 });
  });

  it('never treats an unreadable live source as zero', () => {
    expect(gossipAccountingStaleness({ supply: 0n, balances: [] }, { gossipVerified: false }))
      .toEqual({ level: 'unknown', label: 'Unverified' });
  });
});
function minimalRuleset(overrides = {}) {
  const { metadata, ...rest } = overrides;
  return {
    mustStartAtOrAfter: 0n,
    duration: 0,
    weight: 0n,
    weightCutPercent: 0,
    approvalHook: ZERO,
    metadata: { ...defaultRulesetMetadata, ...(metadata || {}) },
    splitGroups: [],
    fundAccessLimitGroups: [],
    ...rest,
  };
}

describe('loan — REVLoans.borrowFrom', () => {
  it('keeps the net opening quote aligned with its fee breakdown', () => {
    expect(loanOpeningAmounts(1_000_000n, 25, false)).toEqual({
      gross: 1_000_000n,
      protocolFee: 25_000n,
      revFee: 10_000n,
      sourceFee: 25_000n,
      net: 940_000n,
    });
    expect(loanOpeningAmounts(1_000_000n, 500, true).net).toBe(490_000n);
  });

  it('describes a fully prepaid unlock fee without saying “after never”', () => {
    expect(loanUnlockFeeText(500, '0.5 USDC')).toBe('Never grows — fully prepaid');
    expect(loanUnlockFeeText(25, '0.975 USDC')).toBe('Grows after 6 months; up to ~ 0.975 USDC by year 10');
  });

  it('requires a resolved accounting token before building the borrow token arg', () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(borrowLoanTokenForAccountContext(null, true)).toBe(null);
    expect(borrowLoanTokenForAccountContext(null, false)).toBe(null);
    expect(borrowLoanTokenForAccountContext({ address: NATIVE_TOKEN }, false)).toBe(NATIVE_TOKEN);
    expect(borrowLoanTokenForAccountContext({ address: usdc }, false)).toBe(usdc);
  });
  it('derives minBorrow from the source token accounting context, not the base-currency preview', () => {
    const usdc = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(tokenCurrencyIdForAccounting(NATIVE_TOKEN)).toBe(BigInt(NATIVE_TOKEN) & 0xffffffffn);
    expect(borrowCurrencyForAccountContext({ address: usdc, currency: 12345 })).toBe(12345n);
    expect(borrowCurrencyForAccountContext({ address: usdc })).toBe(BigInt(usdc) & 0xffffffffn);
    expect(borrowMinAmountFromPreview(1000000n)).toBe(990000n);
    expect(borrowMinAmountFromPreview(1n)).toBe(1n);
    expect(borrowMinAmountFromPreview(0n)).toBe(0n);
    expect(borrowMinAmountFromPreview('bad')).toBe(0n);
  });
  it('arg order matches the ABI + round-trips', () => {
    const tx = buildBorrowArgs({ chainId: 1, loansAddr: LOANS, revnetId: 3, token: NATIVE_TOKEN, minBorrow: 1n, collateral: parseEther('5'), beneficiary: BOB, prepaidFeePercent: 25, holder: BOB });
    expect(tx.args[0]).toBe(3n);
    expect(tx.args[1]).toBe(NATIVE_TOKEN);
    expect(tx.args[2]).toBe(1n);
    expect(tx.args[3]).toBe(parseEther('5'));
    expect(tx.args[4]).toBe(BOB);
    expect(tx.args[5]).toBe(25n);
    expect(tx.args[6]).toBe(BOB);
    expect(roundTrips(tx.abi, 'borrowFrom', tx.args)).toBe(true);
    expect(() => buildBorrowArgs({ chainId: 1, loansAddr: LOANS, revnetId: 3, token: NATIVE_TOKEN, minBorrow: 0n, collateral: 1n, beneficiary: BOB, prepaidFeePercent: 25, holder: BOB })).toThrow(/quote/i);
  });
  it('honors a minBorrow floor when supplied (ready for the audit L-4 slippage wiring)', () => {
    const tx = buildBorrowArgs({ chainId: 1, loansAddr: LOANS, revnetId: 3, token: NATIVE_TOKEN, minBorrow: parseEther('99'), collateral: parseEther('5'), beneficiary: BOB, prepaidFeePercent: 0, holder: BOB });
    expect(tx.args[2]).toBe(parseEther('99'));
  });
});

describe('loan — REVLoans.repayLoan (payable)', () => {
  it('value = maxRepay buffer; empty permit2 tuple; round-trips', () => {
    const v = parseEther('10');
    const tx = buildRepayArgs({ chainId: 1, loansAddr: LOANS, loanId: 42, maxRepay: v, collateralToReturn: parseEther('5'), beneficiary: BOB, value: v });
    expect(tx.value).toBe(v);
    expect(tx.args[0]).toBe(42n);
    expect(tx.args[1]).toBe(v);
    expect(tx.args[2]).toBe(parseEther('5'));
    expect(tx.args[3]).toBe(BOB);
    expect(tx.args[4].amount).toBe(0n); // EMPTY_PERMIT2 (no permit signature)
    expect(roundTrips(tx.abi, 'repayLoan', tx.args)).toBe(true);
  });
  it('ERC-20 repayment sends no native value and preserves the source-token max', () => {
    const max = 12500000n;
    const tx = buildRepayArgs({ chainId: 1, loansAddr: LOANS, loanId: 7, maxRepay: max, collateralToReturn: parseEther('1'), beneficiary: BOB, value: 0n });
    expect(tx.value).toBe(0n);
    expect(tx.args[1]).toBe(max);
    expect(sourceTokenMeta({}, 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toMatchObject({ decimals: 6, symbol: 'USDC' });
  });
});

describe('source-of-truth data guards', () => {
  it('labels the amount below the owners chart as the total supply', () => {
    expect(ownersChartTotalLabel(68470000000000000000n, 'BEN')).toBe('Total: 68.47 BEN');
  });

  it('clears only a light image matte connected to all four outer corners', () => {
    const width = 5, height = 5;
    const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
    // A black ring isolates the center white pixel, representing white logo detail inside dark artwork.
    for (let y = 1; y <= 3; y++) {
      for (let x = 1; x <= 3; x++) {
        if (x === 2 && y === 2) continue;
        const offset = (y * width + x) * 4;
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
      }
    }
    expect(clearLightEdgeMatte(pixels, width, height)).toBe(true);
    expect(pixels[3]).toBe(0); // outer matte becomes transparent
    expect(pixels[((2 * width + 2) * 4) + 3]).toBe(255); // isolated white logo detail stays opaque
    expect(pixels[((1 * width + 1) * 4) + 3]).toBe(255); // dark artwork stays opaque

    const noMatte = new Uint8ClampedArray(width * height * 4).fill(0);
    expect(clearLightEdgeMatte(noMatte, width, height)).toBe(false);
  });

  it('does not invent pre-deployment history for a selected price-chart range', () => {
    const year = 365 * 86400;
    const now = 2_000_000_000;
    const deployedTwentyMinutesAgo = now - 20 * 60;
    expect(priceChartTimeBounds(deployedTwentyMinutesAgo, now, 1, true)).toEqual({
      t0: deployedTwentyMinutesAgo,
      t1: now,
    });
    expect(priceChartTimeBounds(now - 2 * year, now, 1, true).t0).toBe(now - year);
    expect(priceChartTimeBounds(now - 2 * year, now, 0, true).t0).toBe(now - 2 * year);
  });

  it('keeps resolved market outliers from flattening the issuance-price steps', () => {
    const issuanceMax = issuancePriceScaleMax([0.0004, 0.0007, 0.0011]);
    expect(issuanceMax).toBeCloseTo(0.0011);
    expect(issuancePriceScaleRatio(0.0004, issuanceMax)).toBeCloseTo(0.0004 / 0.0011);
    expect(issuancePriceScaleRatio(0.1088, issuanceMax)).toBe(1);
  });

  it('maps the nested sucker-group projectPage relation by chain', () => {
    const data = { suckerGroup: { projects: { items: [
      { chainId: 1, projectId: 7 }, { chainId: 10, projectId: 9 },
    ] } } };
    // A group which claims a different project on the route's own chain is not authoritative for this route.
    expect(projectIdsByChainFromSuckerGroup(data, 10, 99)).toEqual({ 10: 99 });
    expect(projectIdsByChainFromSuckerGroup(null, 10, 99)).toEqual({ 10: 99 });
    expect(BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY).toMatch(/projects\(where: \{ version: 6 \}, limit: 1000\).*items/s);
  });

  it('normalizes any accounting token with its verified USD quote and preserves raw mixed-token fallbacks', () => {
    expect(accountingTokenUsdValueAtPrice(2500000n, 6, 999500000000000000n, 18)).toBeCloseTo(2.49875);
    expect(accountingTokenUsdValueAtPrice(2n * 10n ** 18n, 18, 4250000000000000000n, 18)).toBe(8.5);

    const rows = [
      { token: NATIVE_TOKEN, balance: 10n ** 18n, decimals: 18, symbol: 'ETH', contextKey: 'native@18' },
      { token: NATIVE_TOKEN, balance: 5n * 10n ** 17n, decimals: 18, symbol: 'ETH', contextKey: 'native@18' },
      { token: USDC, balance: 2500000n, decimals: 6, symbol: 'USDC', contextKey: 'usdc@6' },
    ];
    expect(rawAccountingBalanceSummary(rows, true)).toBe('1.50 ETH + 2.50 USDC');
    expect(rawAccountingBalanceSummary(rows, false)).toBe('—');
  });

  it('keeps a funds tab on the panel snapshot when an older balance probe resolves late', () => {
    const balances = [], snapshotSeen = [];
    expect(updateFundsTabBalance(balances, snapshotSeen, 1, 1n, false)).toBe(true);
    expect(balances[1]).toBe(1n);
    expect(updateFundsTabBalance(balances, snapshotSeen, 1, 2n, true)).toBe(true);
    expect(balances[1]).toBe(2n);
    expect(updateFundsTabBalance(balances, snapshotSeen, 1, 1n, false)).toBe(false);
    expect(balances[1]).toBe(2n);
  });

  it('never guesses an activity token and saturates remaining access', () => {
    expect(indexedActivityAmount(10n ** 18n)).toBe('$1.00');
    expect(indexedActivityAmount(0n)).toBe('');
    expect(remainingAccessAmount(100n, 40n)).toBe(60n);
    expect(remainingAccessAmount(100n, 140n)).toBe(0n);
    expect(quotedOutputFloor(100n)).toBe(99n);
    expect(quotedOutputFloor(1n)).toBe(1n);
  });
});

describe('move between chains — JBSucker.prepare → toRemote', () => {
  it('prepare: bridges the accounting token, approves the sucker, round-trips', () => {
    const tx = buildSuckerPrepareArgs({ chainId: 1, sucker: SUCKER, projectTokenCount: parseEther('100'), beneficiary32: BEN32, minReclaimed: 0n, termToken: NATIVE_TOKEN, metadata: META32, approvalToken: NATIVE_TOKEN, approvalAmount: parseEther('100') });
    expect(tx.args[0]).toBe(parseEther('100'));
    expect(tx.args[1]).toBe(BEN32);
    expect(tx.args[2]).toBe(0n);
    expect(tx.args[3]).toBe(NATIVE_TOKEN);
    expect(tx.spenderAddr).toBe(SUCKER);
    expect(tx.approvalAmount).toBe(parseEther('100'));
    expect(roundTrips(tx.abi, 'prepare', tx.args)).toBe(true);
  });
  it('toRemote: payable value = bridge messaging fee; round-trips', () => {
    const tx = buildSuckerToRemoteArgs({ chainId: 1, sucker: SUCKER, termToken: NATIVE_TOKEN, value: parseEther('0.01') });
    expect(tx.value).toBe(parseEther('0.01'));
    expect(tx.args[0]).toBe(NATIVE_TOKEN);
    expect(roundTrips(tx.abi, 'toRemote', tx.args)).toBe(true);
  });
});

describe('claim credits — JBController.claimTokensFor', () => {
  it('args (holder, projectId, count, beneficiary) + round-trip', () => {
    const tx = buildClaimTokensArgs({ chainId: 1, controllerAddr: LOANS, holder: BOB, projectId: 4, tokenCount: parseEther('50'), beneficiary: BOB });
    expect(tx.args[0]).toBe(BOB);
    expect(tx.args[1]).toBe(4n);
    expect(tx.args[2]).toBe(parseEther('50'));
    expect(tx.args[3]).toBe(BOB);
    expect(roundTrips(tx.abi, 'claimTokensFor', tx.args)).toBe(true);
  });
});

describe('queue rulesets — JBController.queueRulesetsOf', () => {
  it('args (projectId, configs, memo) + round-trip with empty configs', () => {
    const tx = buildQueueRulesetsArgs({ chainId: 1, controllerAddr: LOANS, projectId: 12, rulesetConfigs: [], memo: 'note' });
    expect(tx.args[0]).toBe(12n);
    expect(tx.args[1]).toEqual([]);
    expect(tx.args[2]).toBe('note');
    expect(roundTrips(queueRulesetsAbi, 'queueRulesetsOf', tx.args)).toBe(true);
  });

  it('new fund-access rows default to ETH currency, not invalid 0', () => {
    const group = createDefaultFundAccessLimitGroup();
    group.terminal = LOANS;
    group.payoutLimits[0].amount = '100';
    group.surplusAllowances[0].amount = '50';
    const fundAccessLimitGroups = buildFundAccessLimitGroups([group]);
    expect(fundAccessLimitGroups[0].payoutLimits[0].currency).toBe(1);
    expect(fundAccessLimitGroups[0].surplusAllowances[0].currency).toBe(1);

    const tx = buildQueueRulesetsArgs({
      chainId: 1,
      controllerAddr: LOANS,
      projectId: 12,
      rulesetConfigs: [minimalRuleset({ fundAccessLimitGroups })],
      memo: 'fund access',
    });
    const back = decodeFunctionData({ abi: queueRulesetsAbi, data: encodeFunctionData({ abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: tx.args }) });
    const decodedGroup = back.args[1][0].fundAccessLimitGroups[0];
    expect(decodedGroup.payoutLimits[0].currency).toBe(1);
    expect(decodedGroup.surplusAllowances[0].currency).toBe(1);
  });

  it('drops zero-percent split rows before encoding', () => {
    const splitGroups = buildSplitGroups([{
      groupId: '1',
      splits: [
        { percent: 0, projectId: '', beneficiary: BOB, preferAddToBalance: false, lockedUntil: '', hook: '' },
        { percent: '', projectId: '99', beneficiary: ZERO, preferAddToBalance: false, lockedUntil: '', hook: '' },
        { percent: 500000000, projectId: '', beneficiary: BOB, preferAddToBalance: false, lockedUntil: '', hook: '' },
      ],
    }]);
    expect(splitGroups).toHaveLength(1);
    expect(splitGroups[0].splits).toHaveLength(1);
    expect(splitGroups[0].splits[0].percent).toBe(500000000);

    const tx = buildQueueRulesetsArgs({
      chainId: 1,
      controllerAddr: LOANS,
      projectId: 12,
      rulesetConfigs: [minimalRuleset({ splitGroups })],
      memo: 'splits',
    });
    const back = decodeFunctionData({ abi: queueRulesetsAbi, data: encodeFunctionData({ abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: tx.args }) });
    expect(back.args[1][0].splitGroups[0].splits).toHaveLength(1);
    expect(back.args[1][0].splitGroups[0].splits[0].percent).toBe(500000000);
  });

  it('clamps ruleset weight to uint112 before ABI encoding', () => {
    const hugeWeight = '999999999999999999999999999999999999';
    expect(parseRulesetWeight(hugeWeight)).toBe(UINT112_MAX);
    expect(parseRulesetWeight('-1')).toBe(0n);

    const rs = createDefaultRuleset();
    rs.weight = hugeWeight;
    const rulesetConfigs = buildRulesetConfigs([rs]);
    expect(rulesetConfigs[0].weight).toBe(UINT112_MAX);

    const tx = buildQueueRulesetsArgs({
      chainId: 1,
      controllerAddr: LOANS,
      projectId: 12,
      rulesetConfigs,
      memo: 'weight clamp',
    });
    const back = decodeFunctionData({ abi: queueRulesetsAbi, data: encodeFunctionData({ abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: tx.args }) });
    expect(back.args[1][0].weight).toBe(UINT112_MAX);
  });
});
