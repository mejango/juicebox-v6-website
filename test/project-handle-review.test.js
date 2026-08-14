import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { applyDiscoverRoute, applyVerifiedProjectAuthority, BENDYSTRAW_PROJECT_HANDLE_OPERATOR_QUERY, canReuseProjectDetail, fetchSafeInfo, findEnsRecordWriteAuthority, inspectProjectHandleAuthorityIdentity, liveRevnetOperatorFromPermissionHistory, liveRevnetOperatorFromRows, navigateProjectSection, projectAuthoritySafeQueueGroups, projectSafeQueueChains, queuedHandleBindingMatchesTargets, queuedProjectHandleCallMatchesTargets, renderDiscoverTab, safeAuthorityAccessMode, safeInfoForAuthority, verifiedHandleProjectGroup, verifyCompletedQueuedProjectHandleTransaction, verifyEnsRecordWriteAuthorization, verifyProjectHandleAuthorityIdentity, verifyPublishedProjectHandle, verifyQueuedProjectHandleTransaction } from '../src/discover.js';
import { buildSetEnsProjectRecordCall, buildSetProjectHandleCall } from '../src/project-handles.js';

const SAFE = '0x9191919191919191919191919191919191919191';
const OWNER = '0x2222222222222222222222222222222222222222';
const STALE = '0x3333333333333333333333333333333333333333';
const SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a';
const FALLBACK = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const SENTINEL = '0x0000000000000000000000000000000000000001';
const SINGLETON_SLOT = '0x' + '0'.repeat(64);
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const FALLBACK_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const SAFE_PROXY_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033';
const SAFE_VIEW_ABI = [
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
  { type: 'function', name: 'masterCopy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];

function storageAddress(address) { return '0x' + '0'.repeat(24) + address.slice(2); }

function safeIdentityClient(opts = {}) {
  var owners = opts.owners || [OWNER, STALE];
  var singleton = opts.singleton || SINGLETON;
  var fallback = opts.fallback || FALLBACK;
  var contractOwners = (opts.contractOwners || []).map(function (owner) { return owner.toLowerCase(); });
  return {
    getCode: vi.fn(async function ({ address }) {
      var lower = address.toLowerCase();
      if (lower === SAFE.toLowerCase()) return SAFE_PROXY_CODE;
      if (lower === singleton.toLowerCase() || lower === fallback.toLowerCase() || contractOwners.includes(lower)) return '0x1234';
      return undefined;
    }),
    getStorageAt: vi.fn(async function ({ slot }) {
      if (slot === SINGLETON_SLOT) return storageAddress(singleton);
      if (slot === GUARD_SLOT) return storageAddress(opts.guard || '0x0000000000000000000000000000000000000000');
      if (slot === FALLBACK_SLOT) return storageAddress(fallback);
      throw new Error('unexpected slot');
    }),
    request: vi.fn(async function ({ method, params }) {
      expect(method).toBe('eth_call');
      expect(params[0].gas).toBe('0x493e0');
      var decoded = decodeFunctionData({ abi: SAFE_VIEW_ABI, data: params[0].data });
      var functionName = decoded.functionName;
      var result;
      if (functionName === 'getThreshold') result = BigInt(opts.threshold || 2);
      else if (functionName === 'getOwners') {
        if (opts.rawOwnersResponse) return opts.rawOwnersResponse;
        result = owners;
      }
      else if (functionName === 'getModulesPaginated') result = [opts.modules || [], SENTINEL];
      else if (functionName === 'masterCopy') result = opts.masterCopy || singleton;
      else if (functionName === 'VERSION') result = opts.version || '1.4.1';
      else throw new Error('unexpected read');
      return encodeFunctionResult({ abi: SAFE_VIEW_ABI, functionName: functionName, result: result });
    }),
  };
}

describe('project-handle route lifecycle', () => {
  it('keeps the editor self-service, exact-tuple scoped, single-action, and resumable', () => {
    var source = readFileSync('src/discover.js', 'utf8');
    var start = source.indexOf('function openProjectHandleModal');
    var end = source.indexOf('function appendPendingSafeTxsCard', start);
    var editor = source.slice(start, end);
    expect(editor).toContain("input.placeholder = 'banny.eth'");
    expect(editor).toContain('Enter any .eth name you control.');
    expect(editor).toContain("var primary = el('button', 'operator-cta operator-edit-submit')");
    expect(editor).not.toContain("textContent = '1. Set ENS record'");
    expect(editor).not.toContain("textContent = '2. Publish handle'");
    expect(editor).toContain("'jb-project-handle-draft:' + target.chainId + ':' + target.projectId");
    expect(editor).toContain('authority: String(authority.address || \'\').toLowerCase(), authorityKind: authority.kind');
    expect(editor).toContain('publishPendingHash');
    expect(editor).toContain('pendingHandleWriteState(normalized)');
    expect(editor).toContain('pendingEnsWriteState(review)');
    expect(editor).toContain('publishedHandle = await canonicalProjectHandleOf(target, liveAuthority.address)');
    expect(editor).toContain('projectHandleEditorStep({');
    expect(editor).toContain('chainId: target.chainId, projectId: target.projectId');
    expect(editor).toContain('parts: normalized.parts');
    expect(editor).toContain("gas: 300000n");
    expect(editor).toContain("gas: 1500000n");
    expect(editor).toContain('result.relayr || result.executedReady || Number(result.executed) > 0');
  });

  it('routes only by exact ENS forward tuple, live authority, and the matching canonical reverse claim', () => {
    var source = readFileSync('src/discover.js', 'utf8');
    var start = source.indexOf('async function resolveProjectHandleRoute');
    var end = source.indexOf('export function applyDiscoverRoute', start);
    var resolver = source.slice(start, end);
    var forward = resolver.indexOf('exactEnsProjectRecord(parsed.ensName)');
    var tuple = resolver.indexOf('parseProjectHandleText(ensRecord.text)');
    var authority = resolver.indexOf('projectHandleAuthorityOf(target.chainId, target.projectId');
    var reverse = resolver.indexOf('canonicalProjectHandleOf(target, authority.address)');
    expect(forward).toBeGreaterThan(-1);
    expect(tuple).toBeGreaterThan(forward);
    expect(authority).toBeGreaterThan(tuple);
    expect(reverse).toBeGreaterThan(authority);
    expect(resolver).not.toContain('ensNamePartsOf');
    expect(resolver).not.toContain('Bendystraw');
  });

  it('never reuses a project-detail controller after its DOM was detached for a handle skeleton', () => {
    var element = document.createElement('div');
    var active = { key: 'base:7', element: element };
    expect(canReuseProjectDetail(active, 'base:7')).toBe(false);
    document.body.appendChild(element);
    expect(canReuseProjectDetail(active, 'base:7')).toBe(true);
    element.remove();
    expect(canReuseProjectDetail(active, 'base:7')).toBe(false);
  });

  it('defers a handle-backed tab switch to hash routing instead of mutating the current detail', () => {
    history.replaceState(null, '', '/#@design.juicebox/overview');
    window.__suppressHash = false;
    var switchImmediately = vi.fn();
    expect(navigateProjectSection({ _urlHandle: 'design.juicebox' }, 'Owner', null, switchImmediately)).toBe(false);
    expect(switchImmediately).not.toHaveBeenCalled();
    expect(location.hash).toBe('#@design.juicebox/owner');
    expect(window.__suppressHash).toBe(false);
  });

  it('keeps the immediate connected-detail fast path for numeric routes', () => {
    history.replaceState(null, '', '/#base:7/overview');
    window.__suppressHash = false;
    var switchImmediately = vi.fn();
    var project = { id: 7, chainId: 8453, _urlChainId: 8453 };
    expect(navigateProjectSection(project, 'Owner', null, switchImmediately)).toBe(true);
    expect(switchImmediately).toHaveBeenCalledOnce();
    expect(location.hash).toBe('#base:7/owner');
    expect(window.__suppressHash).toBe(true);
    window.__suppressHash = false;
  });

  it('replaces the grid and any stale route surface with a malformed-handle error', () => {
    document.body.innerHTML = '<section id="tab-discover"></section>';
    renderDiscoverTab();
    var grid = document.querySelector('.discover-grid-wrapper');
    var stale = document.createElement('div');
    stale.className = 'project-detail';
    document.getElementById('tab-discover').appendChild(stale);

    applyDiscoverRoute('@%E0%A4%A');

    expect(grid.style.display).toBe('none');
    expect(stale.isConnected).toBe(false);
    var details = document.querySelectorAll('#tab-discover > .project-detail');
    expect(details).toHaveLength(1);
    expect(details[0].textContent).toMatch(/malformed/i);
    document.body.innerHTML = '';
  });

  it('routes Enter on an explicit valid @handle instead of leaving it as a text filter', () => {
    document.body.innerHTML = '<section id="tab-discover"></section>';
    history.replaceState(null, '', '/#discover');
    renderDiscoverTab();
    var input = document.querySelector('.discover-search input');
    input.value = '@Design.Juicebox.eth';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    var enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });

    input.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(location.hash).toBe('#@design.juicebox');
    document.body.innerHTML = '';
    history.replaceState(null, '', '/');
  });
});

describe('project-handle Safe authority detection', () => {
  it('falls back to the project chain when the authority Safe is not deployed on Ethereum', async () => {
    var projectSafe = { owners: [OWNER], threshold: 1 };
    var fetcher = vi.fn(async function (_address, chainId) { return chainId === 8453 ? projectSafe : null; });
    await expect(safeInfoForAuthority(SAFE, 1, 8453, fetcher)).resolves.toBe(projectSafe);
    expect(fetcher.mock.calls.map(function (call) { return call[1]; })).toEqual([1, 8453]);
  });

  it('uses the Ethereum Safe directly when it is already deployed there', async () => {
    var ethereumSafe = { owners: [OWNER], threshold: 1 };
    var fetcher = vi.fn().mockResolvedValue(ethereumSafe);
    await expect(safeInfoForAuthority(SAFE, 1, 8453, fetcher)).resolves.toBe(ethereumSafe);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('queries only once when the execution and authority chains are the same', async () => {
    var fetcher = vi.fn().mockResolvedValue({ owners: [OWNER], threshold: 1 });
    await safeInfoForAuthority(SAFE, 1, 1, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('evicts a null Safe result so a same-address deployment is detected on the next read', async () => {
    var absentClient = { request: vi.fn().mockRejectedValue(new Error('not deployed')) };
    await expect(fetchSafeInfo(SAFE, 1, function () { return absentClient; })).resolves.toBeNull();

    var deployedClient = safeIdentityClient({ owners: [OWNER], threshold: 1 });
    await expect(fetchSafeInfo(SAFE, 1, function () { return deployedClient; })).resolves.toEqual({
      owners: [OWNER], threshold: 1,
    });
    expect(deployedClient.request).toHaveBeenCalledTimes(4);
  });

  it('recognizes the Safe itself inside a Safe App without requiring it among its EOA owners', () => {
    expect(safeAuthorityAccessMode(SAFE, SAFE, { owners: [OWNER], threshold: 1 }, true)).toBe('safe-app');
    expect(safeAuthorityAccessMode(OWNER, SAFE, { owners: [OWNER], threshold: 1 }, false)).toBe('owner');
    expect(safeAuthorityAccessMode(SAFE, SAFE, { owners: [OWNER], threshold: 1 }, false)).toBeNull();
  });

  it('does not classify a Safe-like arbitrary contract for transaction dispatch', async () => {
    var spoof = {
      getCode: vi.fn().mockResolvedValue('0x6001'),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: SAFE_VIEW_ABI, functionName: 'getOwners', result: [OWNER],
      })),
    };
    await expect(fetchSafeInfo(STALE, 10, function () { return spoof; })).resolves.toBeNull();
    expect(spoof.request).not.toHaveBeenCalled();
  });
});

describe('cross-chain project-handle authority identity', () => {
  it('accepts an EOA only when both project chain and Ethereum have no code', async () => {
    var source = { getCode: vi.fn().mockResolvedValue(undefined) };
    var mainnet = { getCode: vi.fn().mockResolvedValue('0x') };
    var clients = function (chainId) { return chainId === 8453 ? source : mainnet; };
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, clients)).resolves.toMatchObject({ kind: 'eoa' });

    mainnet.getCode.mockResolvedValueOnce('0x1234');
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, clients)).rejects.toThrow(/EOA.*contract|contract.*EOA/i);
  });

  it('accepts only plain Safes with exact singleton, fallback handler, owners, and threshold parity', async () => {
    var source = safeIdentityClient();
    var mainnet = safeIdentityClient();
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : mainnet;
    })).resolves.toMatchObject({ kind: 'safe' });

    var rotated = safeIdentityClient({ owners: [OWNER], threshold: 1 });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : rotated;
    })).rejects.toThrow(/different owners or threshold/i);

    var differentSingleton = safeIdentityClient({ singleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552', version: '1.3.0' });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : differentSingleton;
    })).rejects.toThrow(/different singleton or fallback handler/i);
  });

  it('rejects guards, modules, contract owners, and unverifiable Safe storage', async () => {
    var source = safeIdentityClient();
    for (var unsafe of [
      safeIdentityClient({ guard: OWNER }),
      safeIdentityClient({ modules: [OWNER] }),
      safeIdentityClient({ contractOwners: [OWNER] }),
    ]) {
      await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
        return chainId === 8453 ? source : unsafe;
      })).rejects.toThrow(/guard|modules|owners are EOAs/i);
    }
    var unreadable = safeIdentityClient(); unreadable.getStorageAt.mockRejectedValue(new Error('RPC down'));
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : unreadable;
    })).rejects.toThrow(/RPC down|supported Safe/i);
  });

  it('binds masterCopy and VERSION to the supported singleton', async () => {
    var source = safeIdentityClient();
    for (var invalid of [
      safeIdentityClient({ masterCopy: OWNER }),
      safeIdentityClient({ version: '1.3.0' }),
    ]) {
      await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
        return chainId === 8453 ? source : invalid;
      })).rejects.toThrow(/masterCopy|VERSION/i);
    }
  });

  it('authenticates slot zero before bounded raw policy reads and rejects oversized owners before fan-out', async () => {
    var tooManyOwners = Array.from({ length: 51 }, function (_, index) {
      return '0x' + (index + 1).toString(16).padStart(40, '0');
    });
    var source = safeIdentityClient({ owners: tooManyOwners });
    var mainnet = safeIdentityClient({ owners: tooManyOwners });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : mainnet;
    })).rejects.toThrow(/oversized|too many owners/i);

    var requestedFunctions = source.request.mock.calls.map(function (call) {
      expect(call[0]).toMatchObject({
        method: 'eth_call', params: [expect.objectContaining({ gas: '0x493e0' }), 'latest'],
      });
      return decodeFunctionData({ abi: SAFE_VIEW_ABI, data: call[0].params[0].data }).functionName;
    });
    expect(requestedFunctions[0]).toBe('masterCopy');
    expect(source.getCode.mock.calls.some(function (call) {
      return tooManyOwners.some(function (owner) { return owner.toLowerCase() === call[0].address.toLowerCase(); });
    })).toBe(false);

    var malformed = safeIdentityClient({ rawOwnersResponse: '0x' + '00'.repeat(64) });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? malformed : safeIdentityClient();
    })).rejects.toThrow(/getOwners.*malformed/i);
  });

  it('distinguishes a fully verified source Safe missing on Ethereum from unknown RPC state', async () => {
    var source = safeIdentityClient();
    var emptyMainnet = { getCode: vi.fn().mockResolvedValue(undefined) };
    await expect(inspectProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : emptyMainnet;
    })).resolves.toMatchObject({ kind: 'safe-missing-mainnet', source: { version: '1.4.1' } });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : emptyMainnet;
    })).rejects.toMatchObject({ code: 'safe-missing-mainnet' });

    var unknownMainnet = { getCode: vi.fn().mockResolvedValue(null) };
    await expect(inspectProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : unknownMainnet;
    })).rejects.toThrow(/verify.*both|malformed/i);
  });

  it('treats malformed code and non-canonical address storage as unknown/unsupported, never EOA', async () => {
    var malformedMainnet = { getCode: vi.fn().mockResolvedValue('') };
    await expect(inspectProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? { getCode: vi.fn().mockResolvedValue(undefined) } : malformedMainnet;
    })).rejects.toThrow(/verify.*both|malformed/i);

    var source = safeIdentityClient();
    var badStorage = safeIdentityClient();
    badStorage.getStorageAt.mockImplementation(async function ({ slot }) {
      if (slot === SINGLETON_SLOT) return '0x' + '01' + '0'.repeat(22) + SINGLETON.slice(2);
      if (slot === GUARD_SLOT) return storageAddress('0x0000000000000000000000000000000000000000');
      return storageAddress(FALLBACK);
    });
    await expect(verifyProjectHandleAuthorityIdentity(8453, SAFE, function (chainId) {
      return chainId === 8453 ? source : badStorage;
    })).rejects.toThrow(/proxy storage/i);
  });

  it('exempts an Ethereum-local authority without touching a cross-chain RPC client', async () => {
    var factory = vi.fn(function () { throw new Error('must not be called'); });
    await expect(verifyProjectHandleAuthorityIdentity(1, SAFE, factory)).resolves.toMatchObject({ kind: 'same-chain' });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('revnet handle authority candidates', () => {
  it('queries only rows scoped to the canonical REVOwner permission account', () => {
    expect(BENDYSTRAW_PROJECT_HANDLE_OPERATOR_QUERY).toContain('account: $account');
    expect(BENDYSTRAW_PROJECT_HANDLE_OPERATOR_QUERY).toContain('chainId: $chainId');
    expect(BENDYSTRAW_PROJECT_HANDLE_OPERATOR_QUERY).toContain('projectId: $projectId');
    expect(BENDYSTRAW_PROJECT_HANDLE_OPERATOR_QUERY).not.toContain('isRevnetOperator: true');
  });

  it('rejects a stale first flagged row and accepts the later live REVOwner operator', async () => {
    var isOperatorOf = vi.fn(async function (candidate) { return candidate === SAFE; });
    await expect(liveRevnetOperatorFromRows([
      { operator: STALE, permissions: [1] },
      { operator: SAFE, permissions: [1] },
    ], isOperatorOf)).resolves.toBe(SAFE);
    expect(isOperatorOf.mock.calls.map(function (call) { return call[0]; })).toEqual([STALE, SAFE]);
  });

  it('cancels indexed candidate validation without starting later live checks', async () => {
    var active = true;
    var isOperatorOf = vi.fn(async function () { active = false; return false; });
    await expect(liveRevnetOperatorFromRows([
      { operator: STALE, permissions: [1] },
      { operator: SAFE, permissions: [1] },
    ], isOperatorOf, { shouldContinue: function () { return active; } }))
      .rejects.toMatchObject({ code: 'project-handle-route-cancelled' });
    expect(isOperatorOf).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous indexed rows when REVOwner reports multiple current operators', async () => {
    await expect(liveRevnetOperatorFromRows([
      { operator: STALE, permissions: [1] },
      { operator: SAFE, permissions: [1] },
    ], vi.fn().mockResolvedValue(true))).rejects.toThrow(/more than one current operator/i);
  });

  it('scans the exact canonical permission history range and live-checks newest candidates first', async () => {
    var other = '0x4444444444444444444444444444444444444444';
    var deploymentBlock = 100n;
    var client = {
      getBlockNumber: vi.fn().mockResolvedValue(deploymentBlock + 9n),
      getLogs: vi.fn().mockResolvedValue([
        { blockNumber: deploymentBlock + 8n, logIndex: 0, args: { operator: other } },
        { blockNumber: deploymentBlock + 7n, logIndex: 0, args: { operator: SAFE } },
      ]),
    };
    var validate = vi.fn(async function (candidate) { return candidate === SAFE; });
    await expect(liveRevnetOperatorFromPermissionHistory(client, 8453, 7, OWNER, validate, {
      deploymentBlock, chunkSize: 5n,
    })).resolves.toBe(SAFE);
    expect(client.getLogs).toHaveBeenCalledOnce();
    expect(client.getLogs.mock.calls[0][0]).toMatchObject({
      args: { account: OWNER, projectId: 7n }, fromBlock: 100n, toBlock: 109n,
    });
    expect(validate.mock.calls.map(function (call) { return call[0]; })).toEqual([other, SAFE]);
  });

  it('adaptively splits provider-limited ranges newest-first through the deployment block', async () => {
    var deploymentBlock = 100n;
    var client = {
      getBlockNumber: vi.fn().mockResolvedValue(109n),
      getLogs: vi.fn()
        .mockRejectedValueOnce(new Error('block range is too wide'))
        .mockResolvedValueOnce([{ blockNumber: 108n, logIndex: 0, args: { operator: STALE } }])
        .mockResolvedValueOnce([{ blockNumber: 101n, logIndex: 0, args: { operator: SAFE } }]),
    };
    await expect(liveRevnetOperatorFromPermissionHistory(client, 8453, 7, OWNER, async function (candidate) {
      return candidate === SAFE;
    }, { deploymentBlock })).resolves.toBe(SAFE);
    expect(client.getLogs).toHaveBeenCalledTimes(3);
    expect(client.getLogs.mock.calls[1][0]).toMatchObject({ fromBlock: 105n, toBlock: 109n });
    expect(client.getLogs.mock.calls[2][0]).toMatchObject({ fromBlock: deploymentBlock, toBlock: 104n });
  });

  it('prefers an archive client and falls back for the same exact range', async () => {
    var deploymentBlock = 100n;
    var primary = {
      getBlockNumber: vi.fn().mockResolvedValue(109n),
      getLogs: vi.fn().mockRejectedValue(new Error('archive endpoint unavailable')),
    };
    var fallback = { getLogs: vi.fn().mockResolvedValue([
      { blockNumber: 109n, logIndex: 1, args: { operator: SAFE } },
    ]) };
    await expect(liveRevnetOperatorFromPermissionHistory(primary, 8453, 7, OWNER, async function (candidate) {
      return candidate === SAFE;
    }, { deploymentBlock, fallbackClient: fallback })).resolves.toBe(SAFE);
    expect(primary.getLogs).toHaveBeenCalledOnce();
    expect(fallback.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 100n, toBlock: 109n }));
  });

  it('bounds adaptive RPC work and stops issuing ranges after cancellation', async () => {
    var deploymentBlock = 100n;
    var capped = {
      getBlockNumber: vi.fn().mockResolvedValue(109n),
      getLogs: vi.fn().mockRejectedValue(new Error('too many results')),
    };
    await expect(liveRevnetOperatorFromPermissionHistory(capped, 8453, 7, OWNER, vi.fn(), {
      deploymentBlock, maxRequests: 1,
    })).rejects.toThrow(/bounded RPC request budget/i);
    expect(capped.getLogs).toHaveBeenCalledOnce();

    var active = true;
    var cancelled = {
      getBlockNumber: vi.fn().mockResolvedValue(109n),
      getLogs: vi.fn(async function () { active = false; throw new Error('block range is too wide'); }),
    };
    await expect(liveRevnetOperatorFromPermissionHistory(cancelled, 8453, 7, OWNER, vi.fn(), {
      deploymentBlock, shouldContinue: function () { return active; },
    })).rejects.toMatchObject({ code: 'project-handle-route-cancelled' });
    expect(cancelled.getLogs).toHaveBeenCalledOnce();
  });
});

describe('ENS resolver write authority', () => {
  it('accepts an authorized resolver delegate even when it is not the ENS controller', async () => {
    var delegate = STALE;
    var client = { request: vi.fn(async function ({ method, params }) {
      expect(method).toBe('eth_call');
      if (params[0].from !== delegate) throw new Error('not authorized');
      return '0x';
    }) };
    await expect(findEnsRecordWriteAuthority(client, [OWNER, delegate], {
      target: SAFE, data: '0x1234',
    })).resolves.toBe(delegate);
    expect(client.request).toHaveBeenNthCalledWith(2, {
      method: 'eth_call',
      params: [{ from: delegate, to: SAFE, data: '0x1234', value: '0x0', gas: '0x493e0' }, 'latest'],
    });
  });

  it('fails closed when no connected/controller candidate can simulate the exact setText call', async () => {
    var client = { request: vi.fn().mockRejectedValue(new Error('unauthorized')) };
    await expect(findEnsRecordWriteAuthority(client, [OWNER, OWNER], {
      target: SAFE, data: '0x1234',
    })).resolves.toBeNull();
    expect(client.request).toHaveBeenCalledOnce();
  });

  it('re-simulates the exact resolver call so a revoked delegate cannot sign or post a queued Safe write', async () => {
    var client = {};
    var request = { target: OWNER, data: '0x1234' };
    var record = vi.fn().mockResolvedValue({ resolver: OWNER, text: '1:1' });
    var findAuthority = vi.fn().mockResolvedValue(SAFE);
    await expect(verifyEnsRecordWriteAuthorization({
      client, ensName: 'design.juicebox.eth', resolver: OWNER, expectedText: '8453:7',
      writeAuthority: SAFE, request,
    }, { record, findAuthority })).resolves.toMatchObject({ resolver: OWNER, text: '1:1' });
    expect(findAuthority).toHaveBeenCalledWith(client, [SAFE], request);

    findAuthority.mockResolvedValueOnce(null);
    await expect(verifyEnsRecordWriteAuthorization({
      client, ensName: 'design.juicebox.eth', resolver: OWNER, expectedText: '8453:7',
      writeAuthority: SAFE, request,
    }, { record, findAuthority })).rejects.toThrow(/no longer authorizes/i);
  });

  it('uses the reviewed delegate alone in the final raw no-CCIP resolver authorization probe', async () => {
    var request = { target: OWNER, data: '0x1234' };
    var client = { request: vi.fn().mockResolvedValueOnce('0x').mockRejectedValueOnce(new Error('revoked')) };
    var record = vi.fn().mockResolvedValue({ resolver: OWNER, text: '1:1' });
    var params = {
      client, ensName: 'design.juicebox.eth', resolver: OWNER, expectedText: '8453:7',
      writeAuthority: SAFE, request,
    };
    await expect(verifyEnsRecordWriteAuthorization(params, { record })).resolves.toMatchObject({ resolver: OWNER });
    expect(client.request).toHaveBeenNthCalledWith(1, {
      method: 'eth_call',
      params: [{ from: SAFE, to: OWNER, data: '0x1234', value: '0x0', gas: '0x493e0' }, 'latest'],
    });
    await expect(verifyEnsRecordWriteAuthorization(params, { record })).rejects.toThrow(/no longer authorizes/i);
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});

describe('queued project-handle Safe authority', () => {
  it('adds one exact-project Ethereum handle queue for L2-only projects without duplicating a real sibling', () => {
    expect(projectSafeQueueChains([{ id: 8453, name: 'Base', projectId: 7 }])).toEqual([
      { id: 8453, name: 'Base', projectId: 7 },
      { id: 1, name: 'Ethereum', handleQueueOnly: true, handleQueueTargets: [{ chainId: 8453, projectId: 7 }] },
    ]);
    expect(projectSafeQueueChains([
      { id: 1, name: 'Ethereum', projectId: 2 }, { id: 8453, name: 'Base', projectId: 7 },
    ])).toHaveLength(2);
  });

  it('plans the synthetic Ethereum queue per live authority when sibling owners diverge', () => {
    var groups = projectAuthoritySafeQueueGroups([
      { chainId: 8453, name: 'Base', projectId: 7, owner: SAFE },
      { chainId: 1, name: 'Ethereum', projectId: 2, owner: OWNER },
    ], 'owner');
    var baseOwner = groups.find(function (group) { return group.owner === SAFE; });
    var ethereumOwner = groups.find(function (group) { return group.owner === OWNER; });
    expect(baseOwner.chains).toEqual([
      { id: 8453, name: 'Base', projectId: 7, authorityRole: 'owner' },
      { id: 1, name: 'Ethereum', handleQueueOnly: true, handleQueueTargets: [{ chainId: 8453, projectId: 7 }] },
    ]);
    expect(ethereumOwner.chains).toEqual([
      { id: 1, name: 'Ethereum', projectId: 2, authorityRole: 'owner' },
    ]);
  });

  it('keeps a synthetic mainnet queue scoped to this viewed project’s deployment tuples', () => {
    var targets = [{ chainId: 8453, projectId: 7 }, { chainId: 10, projectId: 9 }];
    expect(queuedHandleBindingMatchesTargets({ binding: { chainId: 8453, projectId: 7 } }, targets)).toBe(true);
    expect(queuedHandleBindingMatchesTargets({ binding: { chainId: 8453, projectId: 8 } }, targets)).toBe(false);
    expect(queuedHandleBindingMatchesTargets(null, targets)).toBe(false);

    var ours = buildSetProjectHandleCall({ chainId: 8453, projectId: 7, parts: ['juicebox', 'design'] });
    var other = buildSetProjectHandleCall({ chainId: 8453, projectId: 8, parts: ['juicebox', 'other'] });
    expect(queuedProjectHandleCallMatchesTargets({ to: ours.target, data: ours.data }, targets)).toBe(true);
    expect(queuedProjectHandleCallMatchesTargets({ to: other.target, data: other.data }, targets)).toBe(false);
    expect(queuedProjectHandleCallMatchesTargets({ to: OWNER, data: '0x12345678' }, targets)).toBe(false);
  });

  it('binds an Ethereum Handles proposal to its encoded L2 authority and exact ENS tuple', async () => {
    var call = buildSetProjectHandleCall({ chainId: 8453, projectId: 7, parts: ['juicebox', 'design'] });
    var tx = { to: call.target, data: call.data, value: '0', operation: 0 };
    var authorityOf = vi.fn().mockResolvedValue({ address: SAFE, kind: 'operator' });
    var ensRecord = vi.fn().mockResolvedValue({ resolver: OWNER, text: '8453:7' });
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { authorityOf, ensRecord })).resolves.toMatchObject({
      kind: 'handle', binding: { chainId: 8453, projectId: 7, handle: 'design.juicebox' },
    });
    expect(authorityOf).toHaveBeenCalledWith({ chainId: 8453, projectId: 7 });
    expect(ensRecord).toHaveBeenCalledWith('design.juicebox.eth');

    authorityOf.mockResolvedValueOnce({ address: STALE, kind: 'operator' });
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { authorityOf, ensRecord }))
      .rejects.toThrow(/live project operator changed/i);
    authorityOf.mockResolvedValueOnce({ address: SAFE, kind: 'operator' });
    ensRecord.mockResolvedValueOnce({ resolver: OWNER, text: '8453:8' });
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { authorityOf, ensRecord }))
      .rejects.toThrow(/exact ENS record no longer points/i);
  });

  it('pins queued ENS setText to its exact resolver and independently authorized ENS Safe', async () => {
    var resolver = OWNER;
    var call = buildSetEnsProjectRecordCall({
      resolver, ensName: 'design.juicebox.eth', chainId: 8453, projectId: 7,
    });
    var tx = { to: resolver, data: call.data, value: '0', operation: 0 };
    var client = {};
    var resolverOf = vi.fn().mockResolvedValue(resolver);
    var findAuthority = vi.fn().mockResolvedValue(SAFE);
    var authorityOf = vi.fn().mockResolvedValue({ address: STALE, kind: 'owner' });
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { client, resolverOf, findAuthority, authorityOf }))
      .resolves.toMatchObject({ kind: 'ens', binding: { chainId: 8453, projectId: 7, text: '8453:7' } });
    expect(authorityOf).not.toHaveBeenCalled();
    expect(resolverOf).toHaveBeenCalledWith(call.args[0]);
    expect(findAuthority).toHaveBeenCalledWith(client, [SAFE], { target: resolver, data: call.data });

    findAuthority.mockResolvedValueOnce(null);
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { client, resolverOf, findAuthority, authorityOf }))
      .rejects.toThrow(/no longer authorizes this Safe/i);
    resolverOf.mockResolvedValueOnce(STALE);
    await expect(verifyQueuedProjectHandleTransaction(SAFE, 1, tx, { client, resolverOf, findAuthority, authorityOf }))
      .rejects.toThrow(/exact ENS resolver changed/i);
  });

  it('accepts a completed exact ENS record from a resolver-authorized Safe distinct from project authority', async () => {
    var resolver = OWNER;
    var call = buildSetEnsProjectRecordCall({
      resolver, ensName: 'banny.eth', chainId: 8453, projectId: 7,
    });
    var authorityOf = vi.fn().mockResolvedValue({ address: STALE, kind: 'owner' });
    var ensNodeRecord = vi.fn().mockResolvedValue({ resolver, text: '8453:7' });
    await expect(verifyCompletedQueuedProjectHandleTransaction(SAFE, 1, {
      to: resolver, data: call.data, value: '0', operation: 0,
    }, { authorityOf, ensNodeRecord })).resolves.toMatchObject({
      kind: 'ens', binding: { chainId: 8453, projectId: 7, text: '8453:7' },
    });
    expect(authorityOf).not.toHaveBeenCalled();
    expect(ensNodeRecord).toHaveBeenCalledWith(call.args[0]);
  });

  it('wires calldata-aware verification into queue load and every sign/execute/batch callback', () => {
    var source = readFileSync('src/discover.js', 'utf8');
    expect(source).toContain('await Promise.all(txs.map(function (tx) { return verifyPendingSafeTransactionAuthority(safe, c, tx); }))');
    expect(source).toContain('return verifyPendingSafeTransactionAuthority(safe, c, tx)');
    expect(source).toMatch(/var specialized = await verifyQueuedProjectHandleTransaction[\s\S]{0,400}if \(chain && chain\.handleQueueOnly\)[\s\S]{0,200}return verifyPendingSafeAuthority/);
    expect(source).toContain("projectAuthoritySafeQueueGroups(res.rows, 'operator')");
    expect(source).toContain("projectAuthoritySafeQueueGroups(res.rows, 'owner')");
    expect(source).toContain('renderOwnerPendingSafeTxs(project, ownerSafeMount)');
    expect(source).toContain('if (!queuedProjectHandleCallMatchesTargets(tx, c.handleQueueTargets)) return null');
    expect(source).toContain('verified && queuedHandleBindingMatchesTargets(verified, c.handleQueueTargets) ? tx : null');
    expect(source).toContain('verifyAuthority: verifyAuthority');
    expect(source).toContain("pendingScope: 'safe-queue:' + relaySafes[0]");
    expect(source).toContain('safeExecutionProofs: safeExecutionProofs');
    expect(source).toContain('quote.expected_transactions = bindRelayrSafeExecutions');
    expect(source).toContain('await verifyPersistedRelayrHandlePostconditions(session.expectedTransactions, records)');
    var preflightStart = source.indexOf('async function preflightReadySafeExecution');
    var preflightEnd = source.indexOf('async function verifyReadySafeTransactions', preflightStart);
    expect(source.slice(preflightStart, preflightEnd)).toContain('from: ZERO_ADDRESS');
    expect(source.slice(preflightStart, preflightEnd)).not.toContain('getAccount()');
  });
});

describe('verified-handle group fallback', () => {
  it('constructs a one-deployment scope when the verified tuple is absent from Bendystraw groups', () => {
    expect(verifiedHandleProjectGroup([], 8453, 7)).toMatchObject({
      key: 'project:8453:7', idByChain: { 8453: 7 },
      chains: [{ id: 8453, projectId: 7 }],
    });
  });

  it('uses a later confirmed sucker group without conflating numeric IDs', () => {
    var grouped = { key: 'sucker:x', chains: [{ id: 8453, projectId: 7 }, { id: 10, projectId: 19 }] };
    expect(verifiedHandleProjectGroup([grouped], 8453, 7)).toBe(grouped);
    expect(verifiedHandleProjectGroup([grouped], 8453, 19).key).toBe('project:8453:19');
  });

  it('rejects owner or revnet-operator churn between alias verification and project render', () => {
    expect(() => applyVerifiedProjectAuthority({ owner: OWNER }, { address: SAFE, kind: 'owner' }, null))
      .toThrow(/owner changed/i);
    expect(() => applyVerifiedProjectAuthority(
      { owner: OWNER, operator: STALE, operatorUnavailable: false },
      { address: SAFE, kind: 'operator' }, OWNER,
    )).toThrow(/operator changed/i);
    expect(() => applyVerifiedProjectAuthority(
      { owner: OWNER, operator: null, operatorUnavailable: true },
      { address: SAFE, kind: 'operator' }, OWNER,
    )).toThrow(/Could not confirm/i);
    var project = { owner: OWNER, operator: SAFE, operatorUnavailable: false };
    expect(applyVerifiedProjectAuthority(project, { address: SAFE, kind: 'operator' }, OWNER)).toBe(project);
    expect(project).toMatchObject({ owner: OWNER, operator: SAFE, isRevnet: true, operatorUnavailable: false });
  });

  it('keeps handle routes out of the numeric model cache and separates operator discovery from handle matching', () => {
    var source = readFileSync('src/discover.js', 'utf8');
    expect(source).toMatch(/var p = _cache\[fk\][\s\S]{0,100}!\(routeContext && routeContext\.handle\)/);
    var start = source.indexOf('async function liveProjectHandleAuthorityOf');
    var end = source.indexOf('async function projectHandleAuthorityOf', start);
    expect(source.slice(start, end)).not.toContain('expectedHandle');
    expect(source).toContain('setVerifiedOperatorCache(resolved.target.projectId, resolved.target.chainId');
    expect(source).toContain('var _operatorDiscoveryInflight = {}');
    expect(source).toContain('var liveSafeInfo = await verifySafeRowAction(r, acct, actionSnapshot.info)');
  });
});

describe('post-receipt project-handle verification', () => {
  it('re-reads authority, exact ENS, and the raw contract handle before reporting success', async () => {
    var authority = { address: SAFE, kind: 'owner' };
    var readers = {
      authorityOf: vi.fn().mockResolvedValue(authority),
      ensRecord: vi.fn().mockResolvedValue({ resolver: OWNER, text: '8453:7' }),
      handleOf: vi.fn().mockResolvedValue('design.juicebox'),
    };
    await expect(verifyPublishedProjectHandle(
      { chainId: 8453, projectId: 7 }, 'design.juicebox', '8453:7', authority, readers,
    )).resolves.toMatchObject({ handle: 'design.juicebox' });
    expect(readers.authorityOf).toHaveBeenCalledWith({ chainId: 8453, projectId: 7 });
    expect(readers.ensRecord).toHaveBeenCalledWith('design.juicebox.eth');
    expect(readers.handleOf).toHaveBeenCalledWith({ chainId: 8453, projectId: 7 }, SAFE);
  });

  it('rejects a normalizable but non-canonical raw handle returned after the receipt', async () => {
    var authority = { address: SAFE, kind: 'owner' };
    await expect(verifyPublishedProjectHandle(
      { chainId: 8453, projectId: 7 }, 'design.juicebox', '8453:7', authority, {
        authorityOf: vi.fn().mockResolvedValue(authority),
        ensRecord: vi.fn().mockResolvedValue({ resolver: OWNER, text: '8453:7' }),
        handleOf: vi.fn().mockResolvedValue('Design.Juicebox'),
      },
    )).rejects.toThrow(/exact canonical handle/i);
  });

  it('stops before ENS and handle reads when the live authority changed', async () => {
    var ensRecord = vi.fn();
    var handleOf = vi.fn();
    await expect(verifyPublishedProjectHandle(
      { chainId: 8453, projectId: 7 }, 'design.juicebox', '8453:7', { address: SAFE, kind: 'owner' }, {
        authorityOf: vi.fn().mockResolvedValue({ address: OWNER, kind: 'owner' }), ensRecord, handleOf,
      },
    )).rejects.toThrow(/authority changed/i);
    expect(ensRecord).not.toHaveBeenCalled();
    expect(handleOf).not.toHaveBeenCalled();
  });

  it.each([
    [{ resolver: null, text: null }],
    [{ resolver: OWNER, text: '8453:8' }],
  ])('stops before handleOf when the exact ENS record is no longer valid', async (record) => {
    var authority = { address: SAFE, kind: 'owner' };
    var authorityOf = vi.fn().mockResolvedValue(authority);
    var handleOf = vi.fn();
    await expect(verifyPublishedProjectHandle(
      { chainId: 8453, projectId: 7 }, 'design.juicebox', '8453:7', authority, {
        authorityOf,
        ensRecord: vi.fn().mockResolvedValue(record),
        handleOf,
      },
    )).rejects.toThrow(/ENS record no longer points/i);
    expect(authorityOf).toHaveBeenCalledOnce();
    expect(handleOf).not.toHaveBeenCalled();
  });

  it('keeps both route acceptance and card display behind exact canonical output checks', () => {
    var source = readFileSync('src/discover.js', 'utf8');
    expect(source).toContain('var verifiedHandle = await canonicalProjectHandleOf(target, authority.address)');
    expect(source).toContain('var verified = identityError ? null : canonicalProjectHandle(values[1])');
  });
});
