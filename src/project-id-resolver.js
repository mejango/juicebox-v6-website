import { bendystrawQueryForNetwork } from './bendystraw-client.js';

const PROJECT_IDENTITY_QUERY = 'query($projectId: Float!, $chainId: Float!, $version: Float!) { '
  + 'project(projectId: $projectId, chainId: $chainId, version: $version) { '
  + 'name handle metadata suckerGroupId } }';

const TESTNET_CHAIN_IDS = new Set([11155111, 11155420, 421614, 84532]);
const CHAIN_NAMES = {
  1: 'Ethereum', 10: 'Optimism', 42161: 'Arbitrum', 8453: 'Base',
  11155111: 'Sepolia', 11155420: 'OP Sepolia', 421614: 'Arbitrum Sepolia', 84532: 'Base Sepolia',
};
const positiveCache = new Map();

function metadataName(metadata) {
  if (!metadata) return null;
  if (typeof metadata === 'object') return metadata.name || null;
  if (typeof metadata !== 'string') return null;
  try {
    var parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' ? parsed.name || null : null;
  } catch (_) { return null; }
}

function chainName(chainId) { return CHAIN_NAMES[chainId] || ('chain ' + chainId); }

export async function lookupProjectIdentity(projectId, chainId) {
  var id = Number(projectId);
  var cid = Number(chainId);
  var key = cid + ':' + id;
  if (positiveCache.has(key)) return positiveCache.get(key);
  var result = { chainId: cid, found: false, name: null, suckerGroupId: null };
  try {
    var data = await bendystrawQueryForNetwork(
      TESTNET_CHAIN_IDS.has(cid) ? 'testnet' : 'mainnet',
      PROJECT_IDENTITY_QUERY,
      { projectId: id, chainId: cid, version: 6 },
    );
    var project = data && data.project;
    if (project) {
      result = {
        chainId: cid,
        found: true,
        name: project.name || metadataName(project.metadata) || project.handle || null,
        suckerGroupId: project.suckerGroupId || null,
      };
      // Identity records are stable. Do not cache misses: a newly launched project or a transient
      // indexer failure should resolve on the next edit instead of staying broken for the session.
      positiveCache.set(key, result);
    }
  } catch (_) {}
  return result;
}

/** Turn exact-chain project reads into the standard one-line field subtext. */
export function projectIdentityHint(projectId, chainIds, lookups) {
  var selected = Array.from(new Set((chainIds || []).map(Number).filter(function (id) { return Number.isSafeInteger(id) && id > 0; })));
  var found = selected.map(function (chainId) {
    return (lookups || []).find(function (result) { return result.chainId === chainId && result.found; });
  }).filter(Boolean);
  if (!found.length) {
    return {
      kind: 'warn',
      text: 'No project #' + projectId + ' found on the selected ' + (selected.length === 1 ? 'chain.' : 'chains.'),
    };
  }
  var named = found.find(function (result) { return result.name; });
  var label = named && named.name ? named.name : ('Project #' + projectId);
  if (selected.length === 1) return { kind: 'ok', text: label };
  if (found.length < selected.length) {
    return {
      kind: 'warn',
      text: label + ' found on ' + found.map(function (result) { return chainName(result.chainId); }).join(', ')
        + ' only — set project IDs per chain.',
    };
  }
  var groups = new Set(found.map(function (result) { return result.suckerGroupId; }).filter(Boolean));
  if (groups.size !== 1 || found.some(function (result) { return !result.suckerGroupId; })) {
    return {
      kind: 'warn',
      text: 'Project #' + projectId + ' exists on every selected chain, but those deployments are not linked — confirm each ID.',
    };
  }
  return { kind: 'ok', text: label + ' on all selected chains' };
}

/** Attach a debounced project-name read directly beneath a project-id input. */
export function attachProjectIdResolver(input, chainIds, opts) {
  opts = opts || {};
  var hint = document.createElement('div');
  hint.className = 'create-resolve-hint';
  hint.style.display = 'none';
  var token = 0;
  var timer = null;
  async function resolve() {
    var value = String(input.value || '').trim().replace(/^#/, '');
    var projectId = Number(value);
    var selected = Array.from(new Set((chainIds || []).map(Number).filter(function (id) { return Number.isSafeInteger(id) && id > 0; })));
    var mine = ++token;
    if (!value) { hint.style.display = 'none'; return; }
    if (!Number.isSafeInteger(projectId) || projectId < 1 || !selected.length) {
      if (opts.silentUnlessNumeric && !/^\d+$/.test(value)) { hint.style.display = 'none'; return; }
      hint.style.display = '';
      hint.className = 'create-resolve-hint warn';
      hint.textContent = 'Not a valid project ID.';
      return;
    }
    hint.style.display = '';
    hint.className = 'create-resolve-hint';
    hint.textContent = 'Looking up project #' + projectId + '…';
    var lookups = await Promise.all(selected.map(function (chainId) { return lookupProjectIdentity(projectId, chainId); }));
    if (mine !== token) return;
    var result = projectIdentityHint(projectId, selected, lookups);
    hint.className = 'create-resolve-hint ' + result.kind;
    hint.textContent = result.text;
  }
  input.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(resolve, 350);
  });
  resolve();
  return hint;
}

export const __test = { metadataName };
