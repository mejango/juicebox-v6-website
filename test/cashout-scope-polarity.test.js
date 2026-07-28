// Cash-out scope polarity (P0-2): JBRulesetMetadata slot 15 is `scopeCashOutsToLocalBalances`
// (true = cash outs use ONLY the local chain's balances). The UI concept "use total surplus for
// cash outs" is the INVERSE (checked = aggregate cross-chain = scope false). These tests pin the
// boundary: hand-written ABIs carry the true on-chain name, and the inversion happens exactly once,
// between the checkbox state and the encoded struct.
import { describe, it, expect } from 'vitest';
import { encodeFunctionData, decodeFunctionData, encodeFunctionResult, decodeFunctionResult } from 'viem';
import controllerJson from '../data/abis/JBController.json';
import { buildRulesetConfigs, createDefaultRuleset, launchProjectAbi } from '../src/launch-component.js';
import { queueRulesetsAbi, buildQueueRulesetsArgs } from '../src/queue-ruleset-component.js';
import { currentRulesetAbi, rulesetRows } from '../src/discover.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const controllerAbi = Array.isArray(controllerJson) ? controllerJson : controllerJson.abi;

const metadataComponentsOf = (abi, fnName) => abi
  .find((x) => x.type === 'function' && x.name === fnName)
  .inputs.find((i) => i.name === 'rulesetConfigurations')
  .components.find((c) => c.name === 'metadata').components;

describe('hand-written encode ABIs name slot 15 with the on-chain name', () => {
  it('queueRulesetsOf + launchProjectFor metadata slot 15 is scopeCashOutsToLocalBalances', () => {
    expect(metadataComponentsOf(queueRulesetsAbi, 'queueRulesetsOf')[14].name).toBe('scopeCashOutsToLocalBalances');
    expect(metadataComponentsOf(launchProjectAbi, 'launchProjectFor')[14].name).toBe('scopeCashOutsToLocalBalances');
  });
});

describe('encode boundary — checkbox "use total surplus" inverts into scopeCashOutsToLocalBalances', () => {
  it('full-metadata branch: checked => scope false, unchecked => scope true', () => {
    const on = createDefaultRuleset();
    on.useTotalSurplusForCashOuts = true;
    expect(buildRulesetConfigs([on])[0].metadata.scopeCashOutsToLocalBalances).toBe(false);

    const off = createDefaultRuleset();
    off.useTotalSurplusForCashOuts = false;
    expect(buildRulesetConfigs([off])[0].metadata.scopeCashOutsToLocalBalances).toBe(true);
  });

  it('pay-data-hook branch: same inversion, same field name', () => {
    const on = createDefaultRuleset();
    on.useTotalSurplusForCashOuts = true;
    expect(buildRulesetConfigs([on], { payDataHookVariant: true })[0].metadata.scopeCashOutsToLocalBalances).toBe(false);

    const off = createDefaultRuleset();
    off.useTotalSurplusForCashOuts = false;
    expect(buildRulesetConfigs([off], { payDataHookVariant: true })[0].metadata.scopeCashOutsToLocalBalances).toBe(true);
  });

  it('default ruleset still encodes scope=false (cross-chain aggregation), byte-identical to before', () => {
    const rs = createDefaultRuleset();
    expect(rs.useTotalSurplusForCashOuts).toBe(true); // checkbox now truthfully shows what is encoded
    expect(buildRulesetConfigs([rs])[0].metadata.scopeCashOutsToLocalBalances).toBe(false);
  });

  it('checkbox state survives an encode -> calldata -> decode round trip with the right polarity', () => {
    const rs = createDefaultRuleset();
    rs.useTotalSurplusForCashOuts = true;
    const tx = buildQueueRulesetsArgs({
      chainId: 1, controllerAddr: ZERO, projectId: 7,
      rulesetConfigs: buildRulesetConfigs([rs]), memo: '',
    });
    const back = decodeFunctionData({
      abi: queueRulesetsAbi,
      data: encodeFunctionData({ abi: queueRulesetsAbi, functionName: 'queueRulesetsOf', args: tx.args }),
    });
    expect(back.args[1][0].metadata.scopeCashOutsToLocalBalances).toBe(false);
  });
});

describe('decode + display — currentRulesetOf metadata read with on-chain meaning', () => {
  const RULESET = {
    cycleNumber: 1n, id: 2n, basedOnId: 0n, start: 0n, duration: 0n,
    weight: 10n ** 18n, weightCutPercent: 0n, approvalHook: ZERO, metadata: 0n,
  };
  const meta = (scope) => ({
    reservedPercent: 0n, cashOutTaxRate: 0n, baseCurrency: 1n,
    pausePay: false, pauseCreditTransfers: false, allowOwnerMinting: false,
    allowSetCustomToken: false, allowTerminalMigration: false, allowSetTerminals: false,
    allowSetController: false, allowAddAccountingContext: false, allowAddPriceFeed: false,
    ownerMustSendPayouts: false, holdFees: false, scopeCashOutsToLocalBalances: scope,
    useDataHookForPay: false, useDataHookForCashOut: false, dataHook: ZERO, metadata: 0n,
  });

  // Encode with the CANONICAL JBController ABI (ground truth), decode with the client's hand-written ABI.
  function decodeWithClientAbi(scope) {
    const data = encodeFunctionResult({
      abi: controllerAbi, functionName: 'currentRulesetOf', result: [RULESET, meta(scope)],
    });
    return decodeFunctionResult({ abi: currentRulesetAbi, functionName: 'currentRulesetOf', data });
  }

  it('the client decodes the canonical scope bit under its true name', () => {
    expect(decodeWithClientAbi(true)[1].scopeCashOutsToLocalBalances).toBe(true);
    expect(decodeWithClientAbi(false)[1].scopeCashOutsToLocalBalances).toBe(false);
  });

  it('display: scope=true shows total surplus Disabled; scope=false shows Enabled', () => {
    const row = (scope) => rulesetRows(RULESET, decodeWithClientAbi(scope)[1], {})
      .find((r) => r[1] === 'Cash outs use total surplus');
    expect(row(true)[2]).toBe('Disabled');
    expect(row(false)[2]).toBe('Enabled');
  });
});
