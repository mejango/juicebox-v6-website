// Per-component transaction arg-builder tests. Each component's inline executeTransaction({...}) arg-building
// was extracted into a pure buildXArgs() so the money path is pinned by a round-trip-through-the-ABI test
// plus value/decimals/recipient/slippage assertions. Grows as each transaction is covered.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData, parseEther, parseUnits } from 'viem';
import { NATIVE_TOKEN } from '../src/component-base.js';
import { buildPayArgs, payAbi } from '../src/pay-component.js';
import { buildCashOutArgs, cashOutMinReclaimed, cashOutAbi } from '../src/cashout-component.js';
import { buildMintArgs, mintTokensAbi } from '../src/mint-component.js';
import { buildBurnArgs, burnTokensAbi } from '../src/burn-component.js';
import { buildDeployErc20Args, deployERC20Abi } from '../src/deploy-erc20-component.js';
import { buildSendReservedArgs, sendReservedAbi } from '../src/reserved-component.js';
import { buildSetPermissionsArgs, parseProjectId, setPermissionsAbi } from '../src/permissions-component.js';
import { availablePayoutAmount, buildSendPayoutsArgs, isExactPayoutCurrency, normalizePayoutContext, payoutBalanceInLimitCurrency, payoutCurrencyIdForSelection, payoutAmountDecimals, payoutOutputFloor, sendPayoutsAbi, tokenCurrencyId } from '../src/payouts-component.js';
import { safeExecArgs, safeExecSignatures, safeUsableConfirmationCount, SAFE_EXEC_ABI } from '../src/safe.js';

const CTRL = '0x4444444444444444444444444444444444444444';
const PERM = '0x5555555555555555555555555555555555555555';
const SALT32 = '0x' + '00'.repeat(32);

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BOB = '0x2222222222222222222222222222222222222222';
const TERMINAL = '0x3333333333333333333333333333333333333333';
const okRoute = (received) => ({ address: TERMINAL, contractName: 'JBMultiTerminal', preview: received != null ? { received, unavailable: false } : null });
const roundTrips = (abi, fn, args) => decodeFunctionData({ abi, data: encodeFunctionData({ abi, functionName: fn, args }) }).args.length === args.length;

describe('pay — JBMultiTerminal.pay', () => {
  it('native: value = amount, no approval, args round-trip the ABI', () => {
    const tx = buildPayArgs({ chainId: 1, projectId: 5, token: NATIVE_TOKEN, amount: parseEther('1'), beneficiary: BOB, memo: 'hi', route: okRoute(parseEther('100')) });
    expect(tx.value).toBe(parseEther('1'));
    expect(tx.tokenAddr).toBeNull();
    expect(tx.args[0]).toBe(5n);
    expect(tx.args[1]).toBe(NATIVE_TOKEN);
    expect(tx.args[2]).toBe(parseEther('1'));
    expect(tx.args[3]).toBe(BOB);
    expect(roundTrips(payAbi, 'pay', tx.args)).toBe(true);
  });
  it('slippage floor = 99% of previewed received (regression — was 0n via missing state.preview.received)', () => {
    const tx = buildPayArgs({ chainId: 1, projectId: 5, token: NATIVE_TOKEN, amount: parseEther('1'), beneficiary: BOB, memo: '', route: okRoute(parseEther('100')) });
    expect(tx.args[4]).toBe((parseEther('100') * 99n) / 100n);
    expect(tx.args[4]).toBeGreaterThan(0n);
    expect(buildPayArgs({ chainId: 1, projectId: 5, token: NATIVE_TOKEN, amount: 1n, beneficiary: BOB, memo: '', route: okRoute(1n) }).args[4]).toBe(1n);
  });
  it('refuses an unpriced payment but allows a verified zero-token payment', () => {
    expect(() => buildPayArgs({ chainId: 1, projectId: 5, token: NATIVE_TOKEN, amount: parseEther('1'), beneficiary: BOB, memo: '', route: okRoute(null) })).toThrow(/preview/i);
    expect(buildPayArgs({ chainId: 1, projectId: 5, token: NATIVE_TOKEN, amount: parseEther('1'), beneficiary: BOB, memo: '', route: okRoute(0n) }).args[4]).toBe(0n);
  });
  it('ERC20 (6-dec USDC): value 0, approves the terminal for the exact amount', () => {
    const tx = buildPayArgs({ chainId: 1, projectId: 5, token: USDC, amount: parseUnits('250', 6), beneficiary: BOB, memo: '', route: okRoute(parseEther('100')) });
    expect(tx.value).toBe(0n);
    expect(tx.tokenAddr).toBe(USDC);
    expect(tx.spenderAddr).toBe(TERMINAL);
    expect(tx.approvalAmount).toBe(250000000n);
  });
});

describe('cashout — JBMultiTerminal.cashOutTokensOf', () => {
  it('minReclaimed = 99% of the previewed reclaim (1% cross-client default)', () => {
    expect(cashOutMinReclaimed(parseEther('100'))).toBe((parseEther('100') * 99n) / 100n);
  });
  it('minReclaimed 0 when reclaim is unknown or zero (preview failed / delay active)', () => {
    expect(cashOutMinReclaimed(null)).toBe(0n);
    expect(cashOutMinReclaimed(0n)).toBe(0n);
    expect(cashOutMinReclaimed(undefined)).toBe(0n);
  });
  it('args carry the floor + count + token, and round-trip the ABI', () => {
    const tx = buildCashOutArgs({ chainId: 1, terminalAddr: TERMINAL, holder: BOB, projectId: 7, cashOutCount: parseEther('10'), tokenToReclaim: NATIVE_TOKEN, beneficiary: BOB, minReclaimed: cashOutMinReclaimed(parseEther('100')) });
    expect(tx.args[1]).toBe(7n);
    expect(tx.args[2]).toBe(parseEther('10'));
    expect(tx.args[3]).toBe(NATIVE_TOKEN);
    expect(tx.args[4]).toBe((parseEther('100') * 99n) / 100n);
    expect(tx.args[5]).toBe(BOB);
    expect(roundTrips(cashOutAbi, 'cashOutTokensOf', tx.args)).toBe(true);
  });
  it('refuses to build a cash out without a non-zero floor', () => {
    expect(() => buildCashOutArgs({ chainId: 1, terminalAddr: TERMINAL, holder: BOB, projectId: 7, cashOutCount: 1n, tokenToReclaim: NATIVE_TOKEN, beneficiary: BOB, minReclaimed: 0n })).toThrow(/preview/i);
    expect(cashOutMinReclaimed(1n)).toBe(1n);
  });
  it('puts an AMM floor in hook metadata while keeping the terminal minimum at zero', () => {
    const metadata = `0x${'11'.repeat(96)}`;
    const tx = buildCashOutArgs({ chainId: 1, terminalAddr: TERMINAL, holder: BOB, projectId: 7, cashOutCount: 1n, tokenToReclaim: NATIVE_TOKEN, beneficiary: BOB, minReclaimed: 0n, metadata });
    expect(tx.args[4]).toBe(0n);
    expect(tx.args[6]).toBe(metadata);
    expect(roundTrips(cashOutAbi, 'cashOutTokensOf', tx.args)).toBe(true);
  });
});

describe('mint — JBController.mintTokensOf', () => {
  it('args (count, beneficiary, useReservedPercent) + round-trip', () => {
    const tx = buildMintArgs({ chainId: 1, controllerAddr: CTRL, projectId: 5, tokenCount: parseEther('100'), beneficiary: BOB, memo: '', useReservedPercent: true });
    expect(tx.args[0]).toBe(5n);
    expect(tx.args[1]).toBe(parseEther('100'));
    expect(tx.args[2]).toBe(BOB);
    expect(tx.args[4]).toBe(true);
    expect(roundTrips(mintTokensAbi, 'mintTokensOf', tx.args)).toBe(true);
  });
});

describe('burn — JBController.burnTokensOf', () => {
  it('args (holder, projectId, count) + round-trip', () => {
    const tx = buildBurnArgs({ chainId: 1, controllerAddr: CTRL, holder: BOB, projectId: 5, tokenCount: parseEther('10'), memo: 'bye' });
    expect(tx.args[0]).toBe(BOB);
    expect(tx.args[1]).toBe(5n);
    expect(tx.args[2]).toBe(parseEther('10'));
    expect(roundTrips(burnTokensAbi, 'burnTokensOf', tx.args)).toBe(true);
  });
});

describe('deploy ERC-20 — JBController.deployERC20For', () => {
  it('args (name, symbol, salt) + round-trip', () => {
    const tx = buildDeployErc20Args({ chainId: 1, controllerAddr: CTRL, projectId: 5, name: 'Token', symbol: 'TKN', salt: SALT32 });
    expect(tx.args[0]).toBe(5n);
    expect(tx.args[1]).toBe('Token');
    expect(tx.args[2]).toBe('TKN');
    expect(tx.args[3]).toBe(SALT32);
    expect(roundTrips(deployERC20Abi, 'deployERC20For', tx.args)).toBe(true);
  });
});

describe('send reserved — JBController.sendReservedTokensToSplitsOf', () => {
  it('single projectId arg + round-trip', () => {
    const tx = buildSendReservedArgs({ chainId: 1, controllerAddr: CTRL, projectId: 9 });
    expect(tx.args[0]).toBe(9n);
    expect(roundTrips(sendReservedAbi, 'sendReservedTokensToSplitsOf', tx.args)).toBe(true);
  });
});

describe('permissions — JBPermissions.setPermissionsFor', () => {
  it('packs operator + projectId + permissionIds tuple; round-trips', () => {
    const tx = buildSetPermissionsArgs({ chainId: 1, permissionsAddr: PERM, account: BOB, operator: BOB, projectId: 7, permissionIds: [1, 34, 35] });
    expect(tx.args[0]).toBe(BOB);
    expect(tx.args[1].operator).toBe(BOB);
    expect(tx.args[1].projectId).toBe(7);
    expect(tx.args[1].permissionIds).toEqual([1, 34, 35]);
    expect(roundTrips(setPermissionsAbi, 'setPermissionsFor', tx.args)).toBe(true);
  });
  it('rejects non-numeric project ids instead of collapsing NaN to wildcard 0; keeps 0 explicit', () => {
    expect(parseProjectId('12,')).toBeNull();
    expect(parseProjectId('12a')).toBeNull();
    expect(parseProjectId('#12')).toBeNull();
    expect(parseProjectId('1 000')).toBeNull();
    expect(parseProjectId(' 7 ')).toBe(7);
    expect(parseProjectId('')).toBe(0);
    expect(parseProjectId('0')).toBe(0);
    expect(() => buildSetPermissionsArgs({ chainId: 1, permissionsAddr: PERM, account: BOB, operator: BOB, projectId: '12,', permissionIds: [1] })).toThrow(/project id/i);
    expect(() => buildSetPermissionsArgs({ chainId: 1, permissionsAddr: PERM, account: BOB, operator: BOB, projectId: '12a', permissionIds: [1] })).toThrow(/project id/i);
    const tx = buildSetPermissionsArgs({ chainId: 1, permissionsAddr: PERM, account: BOB, operator: BOB, projectId: '0', permissionIds: [1] });
    expect(tx.args[1].projectId).toBe(0);
  });
});

describe('send payouts — JBMultiTerminal.sendPayoutsOf', () => {
  it('currency encodes as uint256 (H1 selector fix); args round-trip', () => {
    const cur = Number(BigInt(USDC) & 0xffffffffn);
    const tx = buildSendPayoutsArgs({ chainId: 1, terminalAddr: TERMINAL, projectId: 5, token: USDC, amount: parseUnits('100', 6), currency: cur, minPaidOut: parseUnits('99', 6) });
    expect(tx.args[0]).toBe(5n);
    expect(tx.args[1]).toBe(USDC);
    expect(tx.args[2]).toBe(100000000n);
    expect(tx.args[3]).toBe(BigInt(cur));
    expect(roundTrips(sendPayoutsAbi, 'sendPayoutsOf', tx.args)).toBe(true);
  });
  it('supports standard and custom payout-limit currencies, not just token-derived currency', () => {
    expect(tokenCurrencyId(USDC)).toBe(BigInt(USDC) & 0xffffffffn);
    expect(payoutCurrencyIdForSelection('token', '', USDC)).toBe(BigInt(USDC) & 0xffffffffn);
    expect(payoutCurrencyIdForSelection('eth', '', USDC)).toBe(1n);
    expect(payoutCurrencyIdForSelection('usd', '', USDC)).toBe(2n);
    expect(payoutCurrencyIdForSelection('custom', '12345', USDC)).toBe(12345n);
    expect(payoutCurrencyIdForSelection('custom', '-1', USDC)).toBeNull();

    const tx = buildSendPayoutsArgs({ chainId: 1, terminalAddr: TERMINAL, projectId: 5, token: USDC, amount: parseUnits('100', 6), currency: 2n, minPaidOut: parseUnits('99', 6) });
    expect(tx.args[3]).toBe(2n);
    expect(roundTrips(sendPayoutsAbi, 'sendPayoutsOf', tx.args)).toBe(true);
  });
  it('uses accounting-token decimals for every payout-limit currency', () => {
    // JBCurrencyAmount changes denomination, not fixed-point scale. A USD limit on USDC remains 6 decimals.
    expect(payoutAmountDecimals('token', 6)).toBe(6);
    expect(payoutAmountDecimals('token', 18)).toBe(18);
    expect(payoutAmountDecimals('eth', 6)).toBe(6);
    expect(payoutAmountDecimals('usd', 6)).toBe(6);
    expect(payoutAmountDecimals('custom', 6)).toBe(6);
    expect(parseUnits('100', payoutAmountDecimals('usd', 6))).toBe(parseUnits('100', 6));
    expect(parseUnits('100', payoutAmountDecimals('token', 6))).toBe(parseUnits('100', 6));
    expect(payoutOutputFloor(1000000n)).toBe(990000n);
    expect(payoutOutputFloor(1n)).toBe(1n);
    expect(payoutOutputFloor(1000000n, true)).toBe(1000000n);
    expect(() => buildSendPayoutsArgs({ chainId: 1, terminalAddr: TERMINAL, projectId: 5, token: USDC, amount: 1n, currency: 2n, minPaidOut: 0n })).toThrow(/quote/i);
  });
  it('caps a cross-currency payout by the terminal balance at the protocol price', () => {
    // Reported Base Sepolia case: 0.000025 ETH at 1,817.53 USD/ETH funds 0.04543825 USD, not the 0.05 USD limit.
    const balance = 25000000000000n;
    const usdPerEth = 1817530000000000000000n;
    const remainingUsd = 50000000000000000n;
    expect(payoutBalanceInLimitCurrency(balance, usdPerEth)).toBe(45438250000000000n);
    const available = availablePayoutAmount(remainingUsd, balance, usdPerEth);
    expect(available).toBe(45438250000000000n);
    expect(available * 1000000000000000000n / usdPerEth).toBeLessThanOrEqual(balance);
    expect(availablePayoutAmount(remainingUsd, 1n * 10n ** 18n, usdPerEth)).toBe(remainingUsd);
    expect(availablePayoutAmount(remainingUsd, balance, 1000000000000000000n)).toBe(balance);
    expect(isExactPayoutCurrency(61166n, 61166n)).toBe(true);
    expect(isExactPayoutCurrency(1n, 61166n)).toBe(false); // ETH id still converts when the context uses token id 61166.
  });
  it('rejects malformed accounting contexts before enabling the payout form', () => {
    const context = normalizePayoutContext({ token: USDC, decimals: 6, currency: 2 }, [{ address: USDC, symbol: 'USDC' }]);
    expect(context).toMatchObject({ address: USDC, decimals: 6, currency: 2n, symbol: 'USDC' });
    expect(() => normalizePayoutContext({ token: USDC, decimals: 37, currency: 2 }, [])).toThrow(/decimals/i);
    expect(() => normalizePayoutContext({ token: USDC, decimals: 6, currency: 0 }, [])).toThrow(/currency/i);
  });
});

describe('Safe — GnosisSafe.execTransaction', () => {
  it('builds the exec tuple (to/value/data/operation + gas defaults + signatures); round-trips', () => {
    const tx = { to: TERMINAL, value: '1000000000000000000', data: '0xabcdef', operation: 0 };
    const sigs = '0x' + '11'.repeat(65);
    const args = safeExecArgs(tx, sigs);
    expect(args[0].toLowerCase()).toBe(TERMINAL.toLowerCase());
    expect(args[1]).toBe(10n ** 18n);
    expect(args[2]).toBe('0xabcdef');
    expect(args[3]).toBe(0);
    expect(args[4]).toBe(0n); // safeTxGas defaults
    expect(args[9]).toBe(sigs);
    expect(roundTrips(SAFE_EXEC_ABI, 'execTransaction', args)).toBe(true);
  });
  it('serializes on-chain approveHash confirmations as prevalidated signatures sorted by owner', () => {
    const ownerA = '0x1111111111111111111111111111111111111111';
    const ownerB = '0x2222222222222222222222222222222222222222';
    const ownerBSig = 'aa'.repeat(65);
    const prevalidatedA = ownerA.replace(/^0x/, '').padStart(64, '0') + '0'.repeat(64) + '01';
    const tx = {
      confirmations: [
        { owner: ownerB, signature: '0x' + ownerBSig },
        { owner: ownerA, signature: null, approvedHash: true },
        { signature: '0x' + 'bb'.repeat(65) },
        { owner: null, signature: null },
      ],
    };
    expect(safeUsableConfirmationCount(tx)).toBe(2);
    expect(safeExecSignatures(tx)).toBe('0x' + prevalidatedA + ownerBSig);
    const unproven = { confirmations: [{ owner: ownerA, signature: null }, { owner: ownerB, signature: '0x' + ownerBSig }] };
    expect(safeUsableConfirmationCount(unproven)).toBe(1);
    expect(safeExecSignatures(unproven)).toBe('0x' + ownerBSig);
  });
});
