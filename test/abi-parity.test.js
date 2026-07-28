// Generated ABI-parity guard: every hand-written ABI fragment in src/ is diffed against the canonical
// deployment artifacts in data/abis/*.json — 4-byte selector AND tuple component names/order for the
// JBRulesetMetadata struct. A component NAME can silently drift without changing the selector (names
// don't hash), which is exactly how `useTotalSurplusForCashOuts` masqueraded as slot 15's
// `scopeCashOutsToLocalBalances` with inverted meaning. This suite makes that class of drift loud.
import { describe, it, expect } from 'vitest';
import { toFunctionSelector } from 'viem';
import controllerJson from '../data/abis/JBController.json';
import omnichainJson from '../data/abis/JBOmnichainDeployer.json';
import revDeployerJson from '../data/abis/REVDeployer.json';
import deployer721Json from '../data/abis/JB721TiersHookProjectDeployer.json';
import { queueRulesetsAbi } from '../src/queue-ruleset-component.js';
import { launchProjectAbi } from '../src/launch-component.js';
import { __test } from '../src/create-flow.js';
import { currentRulesetAbi, upcomingRulesetAbi, allRulesetsWithMetadataAbi } from '../src/discover.js';

const { revDeployAbi, revDeploy721Abi, deployer721Abi, omnichainAbi, omnichain721Abi } = __test;

const abiOf = (j) => (Array.isArray(j) ? j : j.abi);
const controllerAbi = abiOf(controllerJson);
const omnichainDeployerAbi = abiOf(omnichainJson);
const revAbi = abiOf(revDeployerJson);
const hook721DeployerAbi = abiOf(deployer721Json);

// Find the canonical overload whose selector matches the hand-written fragment's selector.
function canonicalBySelector(canonicalAbi, fn) {
  const sel = toFunctionSelector(fn);
  const match = canonicalAbi.find((x) => {
    if (x.type !== 'function' || x.name !== fn.name) return false;
    try { return toFunctionSelector(x) === sel; } catch (_) { return false; }
  });
  return { sel, match };
}

// Depth-first search for ruleset-metadata tuples (full JBRulesetMetadata or the reduced
// JBPayDataHookRulesetMetadata, which drops the dataHook slot) anywhere inside an input/output tree.
function findMetadataTuples(nodes, found = []) {
  for (const n of nodes || []) {
    if (n.components) {
      const names = n.components.map((c) => c.name);
      if (names.includes('reservedPercent') && names.includes('cashOutTaxRate') && names.includes('holdFees')) {
        found.push(n.components);
      }
      findMetadataTuples(n.components, found);
    }
  }
  return found;
}

// Full name+type tree of an input list. viem encodes struct args by looking components up BY NAME, so a
// drifted component name silently encodes garbage (or throws) even when the selector still matches.
function nameTree(nodes) {
  return (nodes || []).map((n) => ({
    name: n.name, type: n.type, ...(n.components ? { components: nameTree(n.components) } : {}),
  }));
}

// Every hand-written ENCODE fragment paired with its canonical artifact.
const encodeFragments = [
  ['JBController.queueRulesetsOf (queue component)', controllerAbi, queueRulesetsAbi[0]],
  ['JBController.launchProjectFor (launch component)', controllerAbi, launchProjectAbi[0]],
  ['JBOmnichainDeployer.launchProjectFor (create flow, no 721)', omnichainDeployerAbi, omnichainAbi[0]],
  ['JBOmnichainDeployer.launchProjectFor (create flow, 721)', omnichainDeployerAbi, omnichain721Abi[0]],
  ['JB721TiersHookProjectDeployer.launchProjectFor (create flow)', hook721DeployerAbi, deployer721Abi[0]],
  ['REVDeployer.deployFor (create flow, 4-arg)', revAbi, revDeployAbi[0]],
  ['REVDeployer.deployFor (create flow, 6-arg 721)', revAbi, revDeploy721Abi[0]],
];

describe('encode ABIs — selector parity with canonical deployment artifacts', () => {
  it.each(encodeFragments.map(([label, canonical, fn]) => [label, canonical, fn]))(
    '%s matches a deployed selector', (label, canonical, fn) => {
      const { sel, match } = canonicalBySelector(canonical, fn);
      expect(match, label + ' — no canonical overload has selector ' + sel).toBeTruthy();
    });
});

describe('encode ABIs — full input component name/order/type tree matches the canonical struct', () => {
  it.each(encodeFragments.map(([label, canonical, fn]) => [label, canonical, fn]))(
    '%s', (label, canonical, fn) => {
      const { match } = canonicalBySelector(canonical, fn);
      expect(match, label + ' — selector must match before names can be compared').toBeTruthy();
      expect(nameTree(fn.inputs), label + ' — input tuple component names drifted from data/abis')
        .toEqual(nameTree(match.inputs));
    });

  it('every ruleset-metadata carrier names slot 15 scopeCashOutsToLocalBalances (the P0-2 class)', () => {
    const carriers = encodeFragments.flatMap(([label, , fn]) =>
      findMetadataTuples(fn.inputs).map((components) => [label, components]));
    // The controller/omnichain/721-deployer fragments all carry a ruleset-metadata tuple.
    expect(carriers.length).toBeGreaterThanOrEqual(5);
    for (const [label, components] of carriers) {
      const names = components.map((c) => c.name);
      expect(names, label).toContain('scopeCashOutsToLocalBalances');
      expect(names, label).not.toContain('useTotalSurplusForCashOuts');
    }
  });
});

describe('decode ABIs (discover) — selector + metadata component names match JBController', () => {
  const decodeFragments = [
    ['currentRulesetOf', currentRulesetAbi[0]],
    ['upcomingRulesetOf', upcomingRulesetAbi[0]],
    ['allRulesetsOf', allRulesetsWithMetadataAbi[0]],
  ];

  it.each(decodeFragments)('%s selector matches the deployed controller', (label, fn) => {
    const { sel, match } = canonicalBySelector(controllerAbi, fn);
    expect(match, label + ' — no canonical overload has selector ' + sel).toBeTruthy();
  });

  // Output tuples decode positionally, and the client deliberately widens numeric types to uint256
  // (identical 32-byte decode), so names/order are the load-bearing check here — not types.
  it.each(decodeFragments)('%s output metadata component names/order match', (label, fn) => {
    const { match } = canonicalBySelector(controllerAbi, fn);
    const ours = findMetadataTuples(fn.outputs);
    const theirs = findMetadataTuples(match.outputs);
    expect(ours.length, label + ' — decode fragment has no ruleset-metadata tuple').toBeGreaterThan(0);
    expect(ours.length).toBe(theirs.length);
    for (let i = 0; i < ours.length; i++) {
      expect(ours[i].map((c) => c.name), label + ' — output metadata tuple #' + i)
        .toEqual(theirs[i].map((c) => c.name));
    }
  });
});
