// Generated ABI-parity SWEEP: extracts every hand-written ABI fragment from the wallet-facing
// modules and diffs each function against the canonical deployment artifacts in data/abis/*.json —
// 4-byte selector (via lookup) AND the full tuple component name tree. Component NAMES don't hash
// into the selector, so a drifted name silently encodes garbage or decodes the wrong slot; this
// sweep makes that class of drift loud across the whole surface, not just the 10 fragments the
// original abi-parity suite pinned. Fragments for non-Juicebox infrastructure (Safe contracts,
// Permit2, Uniswap v4 periphery) have no canonical artifact here and live in an EXACT skip list —
// a stale or missing entry fails the suite.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { toFunctionSelector } from 'viem';
import { launchProjectAbi } from '../src/launch-component.js';
import { DEPLOY_721_COMPONENTS, PAY_DATA_HOOK_RULESET_COMPONENTS } from '../src/create-flow.js';

const ROOT = process.cwd();

// ---- fragment extraction: top-level-ish `var NAME = [ … ]` declarations, bracket-matched with
// string/comment awareness so brackets inside quotes or comments don't derail the parse.
function matchBracket(src, start) {
  const open = src[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++;
    } else if (c === '[' || c === '{') {
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0 && c === close) return i;
    }
    i++;
  }
  return -1;
}

function extractDeclarations(src) {
  const decls = [];
  const re = /(?:^|\n)[ \t]*(?:export\s+)?(?:var|const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?=[[{])/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = re.lastIndex;
    const end = matchBracket(src, start);
    if (end === -1) continue;
    decls.push({ name: m[1], expr: src.slice(start, end + 1) });
    re.lastIndex = end;
  }
  return decls;
}

// Evaluate object/array literals in declaration order, iterating to a fixpoint so a fragment can
// reference shared component consts declared elsewhere in the file. Non-literal declarations (state
// objects referencing runtime values) simply fail to evaluate and are ignored — unless their name
// looks like an ABI, which fails the suite (an unextractable fragment would silently shrink coverage).
function evaluateDeclarations(decls, seeds) {
  const scope = new Map(Object.entries(seeds || {}));
  let progress = true;
  while (progress) {
    progress = false;
    for (const d of decls) {
      if ('value' in d) continue;
      try {
        const names = [...scope.keys()];
        // eslint-disable-next-line no-new-func
        const value = Function(...names, '"use strict"; return (' + d.expr + ');')(...names.map((n) => scope.get(n)));
        scope.set(d.name, value);
        d.value = value;
        progress = true;
      } catch (_) { /* retried next pass; reported below if it never resolves */ }
    }
  }
  return decls;
}

const isAbiFragment = (v) => Array.isArray(v) && v.length > 0
  && v.every((x) => x && typeof x === 'object' && typeof x.type === 'string')
  && v.some((x) => x.type === 'function');

// ---- canonical index: selector → every artifact overload carrying it.
const abiOf = (j) => (Array.isArray(j) ? j : j.abi);
const canonicalBySelector = new Map();
for (const file of readdirSync(join(ROOT, 'data/abis'))) {
  if (!file.endsWith('.json')) continue;
  const abi = abiOf(JSON.parse(readFileSync(join(ROOT, 'data/abis', file), 'utf8')));
  if (!Array.isArray(abi)) continue;
  for (const fn of abi) {
    if (fn.type !== 'function') continue;
    let sel;
    try { sel = toFunctionSelector(fn); } catch (_) { continue; }
    if (!canonicalBySelector.has(sel)) canonicalBySelector.set(sel, []);
    canonicalBySelector.get(sel).push({ contract: file.replace('.json', ''), fn });
  }
}

// Tuple-name-tree parity: wherever the FRAGMENT declares components, the canonical node at the same
// position must have the same component count and names in the same order, recursively. Top-level
// parameter names and widened numeric types are not compared — selectors pin the types on the input
// side, and outputs decode positionally with deliberate uint256 widening.
function componentParity(fragNodes, canonNodes, path, issues) {
  const frag = fragNodes || [];
  const canon = canonNodes || [];
  for (let i = 0; i < frag.length; i++) {
    const f = frag[i];
    const c = canon[i];
    if (!f || !f.components) continue;
    if (!c || !c.components) { issues.push(path + '[' + i + ']: canonical has no tuple here'); continue; }
    if (f.components.length !== c.components.length) {
      issues.push(path + '[' + i + ']: ' + f.components.length + ' components vs canonical ' + c.components.length);
      continue;
    }
    for (let k = 0; k < f.components.length; k++) {
      const a = f.components[k], b = c.components[k];
      if (a.name && b.name && a.name !== b.name) issues.push(path + '[' + i + '].' + k + ': "' + a.name + '" vs canonical "' + b.name + '"');
    }
    componentParity(f.components, c.components, path + '[' + i + ']', issues);
  }
}

// ---- the sweep surface.
const SWEEP_FILES = [
  'src/pay-component.js', 'src/cashout-component.js', 'src/payouts-component.js', 'src/burn-component.js',
  'src/mint-component.js', 'src/permissions-component.js', 'src/reserved-component.js',
  'src/deploy-erc20-component.js', 'src/project-payer.js', 'src/pay-preview.js', 'src/component-base.js',
  'src/safe.js', 'src/relayr.js', 'src/discover.js',
];

// Fragments for contracts that have NO canonical artifact in data/abis (Safe wallet contracts,
// Permit2, Uniswap v4 periphery/router). Keyed `file → declName.fnName`. EXACT list: an entry that
// stops being needed (artifact added, fragment removed) fails the suite until removed here.
const NO_CANONICAL_ARTIFACT = {
  'src/safe.js': [
    'SAFE_EXEC_ABI.execTransaction',
    'SAFE_ONCHAIN_ABI.approveHash',
    'SAFE_ONCHAIN_ABI.approvedHashes',
    'SAFE_ONCHAIN_ABI.getThreshold',
    'SAFE_ONCHAIN_ABI.getOwners',
    'SAFE_ONCHAIN_ABI.nonce',
    'PROXY_FACTORY_ABI.createProxyWithNonce',
  ],
  'src/discover.js': [
    'v3QuoterAbi.quoteExactInputSingle',
    'v4QuoterAbi.quoteExactInputSingle',
    'urExecuteAbi.execute',
    'extsloadAbi.extsload',
    'SAFE_ABI.getThreshold',
    'SAFE_ABI.getOwners',
    'lpPermit2Abi.allowance',
    'lpPermit2Abi.approve',
    'lpPositionManagerAbi.modifyLiquidities',
    'lpPositionManagerAbi.permit',
    'lpPositionManagerAbi.multicall',
    'lpPositionViewAbi.nextTokenId',
    'lpPositionViewAbi.positionInfo',
    'lpPositionViewAbi.getPoolAndPositionInfo',
    'lpPositionViewAbi.getPositionLiquidity',
    // Uniswap's StateView lens — periphery, so no Juicebox artifact ships its ABI.
    'lpStateViewAbi.getPositionInfo',
    'lpStateViewAbi.getFeeGrowthInside',
  ],
};

// Floor on how many fragments the extractor must find per file — a parser regression that silently
// dropped fragments would otherwise pass as "nothing to check".
const MIN_FRAGMENTS = {
  'src/pay-component.js': 2, 'src/cashout-component.js': 4, 'src/payouts-component.js': 7,
  'src/burn-component.js': 2, 'src/mint-component.js': 1, 'src/permissions-component.js': 1,
  'src/reserved-component.js': 2, 'src/deploy-erc20-component.js': 1, 'src/project-payer.js': 1,
  'src/pay-preview.js': 1, 'src/component-base.js': 6, 'src/safe.js': 3, 'src/relayr.js': 1,
  'src/discover.js': 135,
};

// The tx-critical discover fragments this sweep exists for — each must be found AND canonical-clean.
const REQUIRED_DISCOVER_FRAGMENTS = [
  // pay / balance / cash out
  'payAbi', 'addToBalanceAbi', 'cashOutTokensAbi', 'claimTokensForAbi',
  // loans
  'borrowFromAbi', 'repayLoanAbi', 'loanOfAbi', 'determineSourceFeeAbi', 'borrowableAbi',
  // suckers
  'suckerClaimAbi', 'suckerBridgeAbi', 'suckerTokenMappingAbi', 'suckerSyncAbi',
  'suckerRegistryBridgeAbi', 'suckerPeerIdentityAbi', 'allSuckersOfAbi',
  // terminal / controller reads the money math depends on
  'currentSurplusOfAbi', 'reclaimableAbi', 'feeFreeSurplusOfAbi', 'totalSupplyWithReservedAbi',
  // 721 shop management + ruleset queues
  'adjustTiersAbi', 'queueRulesetsAbi', 'omnichainQueueAbi',
];

// Shared component consts that discover.js pulls in from other modules (imports are invisible to
// the literal evaluator, so they're seeded from the real exports; RULESET_CFG_COMPONENT mirrors
// discover.js's own derivation from the launch ABI).
const SEEDS = {
  launchProjectAbi,
  DEPLOY_721_COMPONENTS,
  PAY_DATA_HOOK_RULESET_COMPONENTS,
  RULESET_CFG_COMPONENT: launchProjectAbi[0].inputs.filter((i) => i.name === 'rulesetConfigurations')[0],
};

function sweepFile(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const decls = evaluateDeclarations(extractDeclarations(src), SEEDS);
  const fragments = decls.filter((d) => isAbiFragment(d.value));
  const abiLookingFailures = decls
    .filter((d) => !('value' in d) && /Abi$|ABI$|_COMPONENTS$/.test(d.name))
    .map((d) => d.name);
  const results = [];
  for (const d of fragments) {
    for (const fn of d.value.filter((x) => x.type === 'function')) {
      const key = d.name + '.' + fn.name;
      let sel;
      try { sel = toFunctionSelector(fn); } catch (e) {
        results.push({ key, status: 'selector-error', detail: String(e && e.message) });
        continue;
      }
      const candidates = canonicalBySelector.get(sel) || [];
      if (!candidates.length) { results.push({ key, status: 'no-canonical', sel }); continue; }
      let matched = null;
      let firstIssues = null;
      for (const c of candidates) {
        const issues = [];
        componentParity(fn.inputs, c.fn.inputs, 'inputs', issues);
        componentParity(fn.outputs, c.fn.outputs, 'outputs', issues);
        if (!issues.length) { matched = c; break; }
        if (!firstIssues) firstIssues = { contract: c.contract, issues };
      }
      if (matched) results.push({ key, status: 'ok', contract: matched.contract });
      else results.push({ key, status: 'drift', detail: 'vs ' + firstIssues.contract + ': ' + firstIssues.issues.join('; ') });
    }
  }
  return { fragments, abiLookingFailures, results };
}

const sweeps = new Map(SWEEP_FILES.map((f) => [f, sweepFile(f)]));

describe('ABI-parity sweep — every hand-written fragment vs data/abis', () => {
  it.each(SWEEP_FILES)('%s: extractor found the expected fragment surface', (file) => {
    const { fragments, abiLookingFailures } = sweeps.get(file);
    expect(abiLookingFailures, file + ' — ABI-looking declarations the evaluator could not resolve').toEqual([]);
    expect(fragments.length, file + ' — fragment count fell below the pinned floor').toBeGreaterThanOrEqual(MIN_FRAGMENTS[file]);
  });

  it.each(SWEEP_FILES)('%s: every fragment matches a canonical artifact (selector + tuple-name tree) or is skip-listed', (file) => {
    const { results } = sweeps.get(file);
    const skip = new Set(NO_CANONICAL_ARTIFACT[file] || []);
    const failures = [];
    for (const r of results) {
      if (r.status === 'ok') {
        if (skip.has(r.key)) failures.push(r.key + ': listed as no-canonical but a canonical artifact matches — remove the stale skip entry');
      } else if (r.status === 'no-canonical') {
        if (!skip.has(r.key)) failures.push(r.key + ' (' + r.sel + '): no canonical artifact and not skip-listed');
      } else {
        failures.push(r.key + ': ' + r.status + ' — ' + r.detail);
      }
    }
    // Exactness in the other direction: every skip entry must correspond to a real fragment.
    const seen = new Set(results.map((r) => r.key));
    for (const key of skip) {
      if (!seen.has(key)) failures.push(key + ': skip-listed but no such fragment exists any more');
    }
    expect(failures).toEqual([]);
  });

  it('discover.js: the tx-critical fragments are all present and canonical-clean', () => {
    const { results } = sweeps.get('src/discover.js');
    const okDecls = new Set(results.filter((r) => r.status === 'ok').map((r) => r.key.split('.')[0]));
    const missing = REQUIRED_DISCOVER_FRAGMENTS.filter((name) => !okDecls.has(name));
    expect(missing, 'tx-critical fragments not found or not clean').toEqual([]);
  });
});
