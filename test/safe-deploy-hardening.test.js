import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult } from 'viem';

const deployState = vi.hoisted(() => ({
  account: '0x9999999999999999999999999999999999999999',
  clients: new Map(),
  switchChain: vi.fn(),
  wallet: null,
}));

vi.mock('../src/component-base.js', () => ({
  getWalletClient: () => deployState.wallet,
  getAccount: () => deployState.account,
  getViewAs: () => null,
  VIEW_AS_TX_ERROR: "You're viewing the site as another account — exit View as to transact.",
  switchChain: deployState.switchChain,
  createPublicClientForChain: chainId => deployState.clients.get(Number(chainId)),
  ZERO_ADDRESS: '0x0000000000000000000000000000000000000000',
}));

import {
  SAFE_SETUP_ABI,
  deploySafeSameAddress,
  fetchSafeCreation,
  safeServiceChainIds,
  verifySafeCreationGovernance,
  verifySafeCreationIdentity,
  verifyPlainSafeDeploymentPolicy,
} from '../src/safe.js';

const SAFE = '0x1111111111111111111111111111111111111111';
const OWNER_A = '0x2222222222222222222222222222222222222222';
const OWNER_B = '0x3333333333333333333333333333333333333333';
const OWNER_C = '0x4444444444444444444444444444444444444444';
const FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const SINGLETON = '0x41675C099F32341bf84BFc5382aF534df5C7461a';
const ALT_SINGLETON = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const HANDLER = '0x7777777777777777777777777777777777777777';
const MODULE = '0x8888888888888888888888888888888888888888';
const HASH = `0x${'ab'.repeat(32)}`;
const SOURCE_CHAIN = 1;
const AUTHORITY_SOURCE_CHAIN = 10;
const TARGET_CHAIN = 8453;
const SENTINEL = '0x0000000000000000000000000000000000000001';
const ZERO_WORD = `0x${'00'.repeat(32)}`;
const SINGLETON_SLOT = ZERO_WORD;
const GUARD_SLOT = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';
const FALLBACK_HANDLER_SLOT = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5';
const PROXY_CODE = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033';
const SINGLETON_CODE = '0x6001';
const HANDLER_CODE = '0x6002';
const FACTORY_CODE = '0x6003';
const EIP_7702_CODE = '0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b';
const SAFE_VIEW_ABI = [
  { type: 'function', name: 'getThreshold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'getOwners', stateMutability: 'view', inputs: [], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
  { type: 'function', name: 'masterCopy', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'VERSION', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'nonce', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
];
const PROXY_FACTORY_ABI = [{
  type: 'function', name: 'createProxyWithNonce', stateMutability: 'nonpayable',
  inputs: [{ type: 'address' }, { type: 'bytes' }, { type: 'uint256' }], outputs: [{ type: 'address' }],
}];

function safeViewResponse(functionName, governance, owners, singleton, afterWrite) {
  var result;
  if (functionName === 'getThreshold') result = afterWrite
    ? configured(governance, 'postThreshold', governance.threshold)
    : governance.threshold;
  else if (functionName === 'getOwners') result = afterWrite
    ? configured(governance, 'postOwners', owners)
    : owners;
  else if (functionName === 'getModulesPaginated') result = [governance.modules || [], governance.moduleNext || SENTINEL];
  else if (functionName === 'masterCopy') result = governance.masterCopy || singleton;
  else if (functionName === 'VERSION') result = governance.version || '1.4.1';
  else if (functionName === 'nonce') result = governance.nonce || 0n;
  else throw new Error('unexpected Safe view');
  return encodeFunctionResult({ abi: SAFE_VIEW_ABI, functionName, result });
}

function safeViewRequest(governance, owners, singleton, afterWrite) {
  return vi.fn(({ method, params }) => {
    if (method !== 'eth_call') return Promise.reject(new Error('unexpected RPC method'));
    try {
      var decoded = decodeFunctionData({ abi: SAFE_VIEW_ABI, data: params[0].data });
      return Promise.resolve(safeViewResponse(decoded.functionName, governance, owners, singleton, afterWrite()));
    } catch (_) {
      var factoryCall = decodeFunctionData({ abi: PROXY_FACTORY_ABI, data: params[0].data });
      if (factoryCall.functionName !== 'createProxyWithNonce') return Promise.reject(new Error('unexpected raw call'));
      return Promise.resolve(encodeFunctionResult({
        abi: PROXY_FACTORY_ABI,
        functionName: 'createProxyWithNonce',
        result: governance.simulatedAddress || SAFE,
      }));
    }
  });
}

function factorySimulationCalls(client) {
  return client.request.mock.calls.filter(function (args) {
    var request = args[0];
    return request && request.method === 'eth_call' && request.params
      && request.params[0] && String(request.params[0].to).toLowerCase() === FACTORY.toLowerCase();
  });
}

function guardWord(address) {
  return `0x${'00'.repeat(12)}${address.slice(2).toLowerCase()}`;
}

function configured(object, key, fallback) {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : fallback;
}

function initializer(overrides = {}) {
  return encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [
      overrides.owners || [OWNER_A, OWNER_B],
      overrides.threshold == null ? 2n : BigInt(overrides.threshold),
      overrides.to || '0x0000000000000000000000000000000000000000',
      overrides.data || '0x',
      overrides.fallbackHandler || HANDLER,
      '0x0000000000000000000000000000000000000000',
      overrides.payment == null ? 0n : BigInt(overrides.payment),
      '0x0000000000000000000000000000000000000000',
    ],
  });
}

function creation(overrides = {}) {
  return {
    factory: FACTORY,
    singleton: SINGLETON,
    initializer: initializer(),
    saltNonce: 42n,
    sourceChainId: SOURCE_CHAIN,
    ...overrides,
  };
}

function sourceClient(governance = { threshold: 2n, owners: [OWNER_B, OWNER_A] }) {
  const owners = governance.owners || [OWNER_B, OWNER_A];
  const singleton = governance.singleton || SINGLETON;
  const fallbackHandler = governance.fallbackHandler || HANDLER;
  return {
    request: safeViewRequest(governance, owners, singleton, () => deployState.wallet.writeContract.mock.calls.length > 0),
    readContract: vi.fn(({ functionName }) => {
      const afterWrite = deployState.wallet.writeContract.mock.calls.length > 0;
      if (functionName === 'getThreshold') return Promise.resolve(afterWrite
        ? configured(governance, 'postThreshold', governance.threshold)
        : governance.threshold);
      if (functionName === 'getOwners') return Promise.resolve(afterWrite
        ? configured(governance, 'postOwners', owners)
        : owners);
      if (functionName === 'getModulesPaginated') return Promise.resolve([
        governance.modules || [], governance.moduleNext || SENTINEL,
      ]);
      if (functionName === 'masterCopy') return Promise.resolve(governance.masterCopy || singleton);
      if (functionName === 'VERSION') return Promise.resolve(governance.version || '1.4.1');
      return Promise.reject(new Error('unexpected source read'));
    }),
    getStorageAt: vi.fn(({ slot }) => {
      if (slot === GUARD_SLOT) return Promise.resolve(governance.guardStorage || ZERO_WORD);
      if (slot === SINGLETON_SLOT) return Promise.resolve(governance.singletonStorage || guardWord(singleton));
      if (slot === FALLBACK_HANDLER_SLOT) return Promise.resolve(governance.fallbackHandlerStorage || guardWord(fallbackHandler));
      return Promise.reject(new Error('unexpected source storage slot'));
    }),
    getBytecode: vi.fn(({ address }) => {
      const lower = address.toLowerCase();
      if (lower === SAFE.toLowerCase()) return Promise.resolve(configured(governance, 'proxyCode', PROXY_CODE));
      if (lower === singleton.toLowerCase()) return Promise.resolve(configured(governance, 'singletonCode', SINGLETON_CODE));
      if (lower === fallbackHandler.toLowerCase() && fallbackHandler !== '0x0000000000000000000000000000000000000000') {
        return Promise.resolve(configured(governance, 'fallbackHandlerCode', HANDLER_CODE));
      }
      if ((governance.delegatedOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve(EIP_7702_CODE);
      if ((governance.prefixedContractOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve(EIP_7702_CODE + '00');
      if ((governance.contractOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve('0x6004');
      return Promise.resolve(undefined);
    }),
  };
}

function targetClient(governance = { threshold: 2n, owners: [OWNER_A, OWNER_B] }) {
  const owners = governance.owners || [OWNER_A, OWNER_B];
  const singleton = governance.singleton || SINGLETON;
  const fallbackHandler = governance.fallbackHandler || HANDLER;
  return {
    request: safeViewRequest(governance, owners, singleton, () => deployState.wallet.writeContract.mock.calls.length > 0),
    getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 1n }),
    estimateContractGas: vi.fn().mockResolvedValue(100000n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    getBytecode: vi.fn(({ address }) => {
      const lower = address.toLowerCase();
      if (lower === SAFE.toLowerCase()) {
        if (governance.occupied) return Promise.resolve(PROXY_CODE);
        return Promise.resolve(deployState.wallet.writeContract.mock.calls.length
          ? configured(governance, 'proxyCode', PROXY_CODE)
          : configured(governance, 'targetAddressCode', undefined));
      }
      if (lower === FACTORY.toLowerCase()) return Promise.resolve(configured(governance, 'factoryCode', FACTORY_CODE));
      // Preflight always checks the creation singleton/handler; postflight may read a different live storage value.
      if (lower === SINGLETON.toLowerCase()) return Promise.resolve(deployState.wallet.writeContract.mock.calls.length
        ? configured(governance, 'postSingletonCode', configured(governance, 'destinationSingletonCode', SINGLETON_CODE))
        : configured(governance, 'destinationSingletonCode', SINGLETON_CODE));
      if (lower === singleton.toLowerCase()) return Promise.resolve(configured(governance, 'singletonCode', SINGLETON_CODE));
      if (lower === HANDLER.toLowerCase()) return Promise.resolve(deployState.wallet.writeContract.mock.calls.length
        ? configured(governance, 'postFallbackHandlerCode', configured(governance, 'destinationFallbackHandlerCode', HANDLER_CODE))
        : configured(governance, 'destinationFallbackHandlerCode', HANDLER_CODE));
      if (lower === fallbackHandler.toLowerCase() && fallbackHandler !== '0x0000000000000000000000000000000000000000') {
        return Promise.resolve(configured(governance, 'fallbackHandlerCode', HANDLER_CODE));
      }
      if ((governance.delegatedOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve(EIP_7702_CODE);
      if ((governance.prefixedContractOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve(EIP_7702_CODE + '00');
      if ((governance.contractOwners || []).some(owner => owner.toLowerCase() === lower)) return Promise.resolve('0x6004');
      return Promise.resolve(undefined);
    }),
    readContract: vi.fn(({ functionName }) => {
      if (functionName === 'getThreshold') return Promise.resolve(governance.threshold);
      if (functionName === 'getOwners') return Promise.resolve(owners);
      if (functionName === 'getModulesPaginated') return Promise.resolve([
        governance.modules || [], governance.moduleNext || SENTINEL,
      ]);
      if (functionName === 'masterCopy') return Promise.resolve(governance.masterCopy || singleton);
      if (functionName === 'VERSION') return Promise.resolve(governance.version || '1.4.1');
      return Promise.reject(new Error('unexpected target read'));
    }),
    getStorageAt: vi.fn(({ slot }) => {
      if (slot === GUARD_SLOT) return Promise.resolve(governance.guardStorage || ZERO_WORD);
      if (slot === SINGLETON_SLOT) return Promise.resolve(governance.singletonStorage || guardWord(singleton));
      if (slot === FALLBACK_HANDLER_SLOT) return Promise.resolve(governance.fallbackHandlerStorage || guardWord(fallbackHandler));
      return Promise.reject(new Error('unexpected target storage slot'));
    }),
  };
}

describe('same-address Safe deployment governance hardening', () => {
  beforeEach(() => {
    localStorage.clear();
    deployState.account = '0x9999999999999999999999999999999999999999';
    deployState.clients.clear();
    deployState.switchChain.mockReset();
    deployState.wallet = {
      getChainId: vi.fn().mockResolvedValue(TARGET_CHAIN),
      writeContract: vi.fn().mockResolvedValue(HASH),
    };
    vi.stubGlobal('fetch', vi.fn());
  });

  it('accepts the plain setup initializer only when current owners and threshold match, regardless of owner order', () => {
    expect(verifySafeCreationGovernance(initializer(), {
      owners: [OWNER_B, OWNER_A],
      threshold: 2,
    })).toEqual({ owners: [OWNER_A, OWNER_B], threshold: 2 });

    expect(() => verifySafeCreationGovernance(initializer(), {
      owners: [OWNER_A, OWNER_C], threshold: 2,
    })).toThrow(/stale governance/i);
    expect(() => verifySafeCreationGovernance(initializer(), {
      owners: [OWNER_A, OWNER_B], threshold: 1,
    })).toThrow(/stale governance/i);
  });

  it('rejects setup delegatecalls/module initializers and setup payments', () => {
    const governance = { owners: [OWNER_A, OWNER_B], threshold: 2 };
    expect(() => verifySafeCreationGovernance(initializer({ to: MODULE, data: '0x1234' }), governance))
      .toThrow(/delegate setup\/module initializer.*unsafe/i);
    expect(() => verifySafeCreationGovernance(initializer({ payment: 1 }), governance))
      .toThrow(/setup payment.*unsafe/i);
  });

  it('accepts only zero-guard, module-free Safe deployment policy', () => {
    expect(verifyPlainSafeDeploymentPolicy({
      guardStorage: ZERO_WORD,
      modulePage: [[], SENTINEL],
    }, 'Source Safe')).toBe(true);
    expect(() => verifyPlainSafeDeploymentPolicy({
      guardStorage: guardWord(MODULE),
      modulePage: [[], SENTINEL],
    }, 'Source Safe')).toThrow(/transaction guard.*unsafe/i);
    expect(() => verifyPlainSafeDeploymentPolicy({
      guardStorage: ZERO_WORD,
      modulePage: [[MODULE], SENTINEL],
    }, 'Source Safe')).toThrow(/enabled modules.*unsafe/i);
    expect(() => verifyPlainSafeDeploymentPolicy({
      guardStorage: ZERO_WORD,
      modulePage: [[], MODULE],
    }, 'Source Safe')).toThrow(/enabled modules.*unsafe/i);
  });

  it('binds the creation singleton and setup fallback handler to live source storage', () => {
    const sourcePolicy = {
      owners: [OWNER_B, OWNER_A], threshold: 2,
      singletonStorage: guardWord(SINGLETON),
      fallbackHandlerStorage: guardWord(HANDLER),
    };
    expect(verifySafeCreationIdentity(initializer(), SINGLETON, sourcePolicy)).toEqual({
      singleton: SINGLETON.toLowerCase(),
      fallbackHandler: HANDLER.toLowerCase(),
    });
    expect(() => verifySafeCreationIdentity(initializer(), MODULE, sourcePolicy))
      .toThrow(/singleton differs.*stopped/i);
    expect(() => verifySafeCreationIdentity(initializer({ fallbackHandler: MODULE }), SINGLETON, sourcePolicy))
      .toThrow(/fallback handler differs.*stopped/i);
    expect(() => verifySafeCreationIdentity(initializer(), SINGLETON, {
      ...sourcePolicy, singletonStorage: '0x1234',
    })).toThrow(/verify.*singleton/i);
  });

  it('records the chain that supplied the creation record', async () => {
    const firstSource = safeServiceChainIds()[0];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        factoryAddress: FACTORY,
        masterCopy: SINGLETON,
        setupData: initializer(),
        saltNonce: '42',
      }),
    });

    await expect(fetchSafeCreation(SAFE)).resolves.toMatchObject({ sourceChainId: firstSource });
  });

  it('verifies source governance before replay and target governance after deployment', async () => {
    const source = sourceClient();
    const target = targetClient();
    deployState.clients.set(SOURCE_CHAIN, source);
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).resolves.toBe(HASH);
    expect(source.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' }));
    expect(target.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'eth_call' }));
    [SINGLETON_SLOT, GUARD_SLOT, FALLBACK_HANDLER_SLOT].forEach(slot => {
      expect(source.getStorageAt).toHaveBeenCalledWith({ address: SAFE, slot });
      expect(target.getStorageAt).toHaveBeenCalledWith({ address: SAFE, slot });
    });
    expect(factorySimulationCalls(target)).toHaveLength(1);
    var rawFactoryCall = factorySimulationCalls(target)[0][0];
    expect(rawFactoryCall.params).toEqual([expect.objectContaining({
      from: deployState.account,
      to: FACTORY,
      value: '0x0',
      gas: '0x4c4b40',
    }), 'latest']);
    expect(decodeFunctionData({ abi: PROXY_FACTORY_ABI, data: rawFactoryCall.params[0].data })).toEqual({
      functionName: 'createProxyWithNonce',
      args: [SINGLETON, creation().initializer, 42n],
    });
    // The 5M cap bounds the simulation above. Sending it would make the wallet
    // reserve cap * maxFeePerGas, so the send carries the measured 2x estimate.
    expect(deployState.wallet.writeContract).toHaveBeenCalledWith(expect.objectContaining({
      address: FACTORY,
      gas: 200000n,
    }));
    expect(source.request.mock.invocationCallOrder[0])
      .toBeLessThan(deployState.wallet.writeContract.mock.invocationCallOrder[0]);
  });

  it('accepts exact EIP-7702-delegated Safe owners on both chains', async () => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], delegatedOwners: [OWNER_A],
    }));
    deployState.clients.set(TARGET_CHAIN, targetClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], delegatedOwners: [OWNER_B],
    }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).resolves.toBe(HASH);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('stops before sending when current source governance no longer matches creation', async () => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({ threshold: 1n, owners: [OWNER_A, OWNER_B] }));
    const target = targetClient();
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(/stale governance/i);
    expect(factorySimulationCalls(target)).toHaveLength(0);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ['a transaction guard', { guardStorage: guardWord(MODULE) }, /transaction guard/i],
    ['an enabled module', { modules: [MODULE] }, /enabled modules/i],
  ])('stops before sending when the source Safe has %s', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));
    const target = targetClient();
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(factorySimulationCalls(target)).toHaveLength(0);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ['an unrecognized proxy runtime', { proxyCode: '0x6000' }, /official SafeProxy runtime/i],
    ['malformed proxy bytecode', { proxyCode: '0x0' }, /malformed bytecode/i],
    ['a mismatched masterCopy', { masterCopy: ALT_SINGLETON }, /masterCopy.*slot zero/i],
    ['a mismatched VERSION', { version: '9.9.9' }, /VERSION.*official singleton/i],
    ['unreadable singleton code', { singletonCode: '0x' }, /singleton bytecode/i],
    ['unreadable fallback-handler code', { fallbackHandlerCode: '0x' }, /fallback handler bytecode/i],
    ['a delegated fallback handler', { fallbackHandlerCode: EIP_7702_CODE }, /delegated fallback handler/i],
    ['a contract owner', { contractOwners: [OWNER_A] }, /contract owner/i],
    ['a prefixed non-7702 contract owner', { prefixedContractOwners: [OWNER_A] }, /contract owner/i],
  ])('stops before sending when the source Safe has %s', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));
    deployState.clients.set(TARGET_CHAIN, targetClient());

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('rejects a creation record outside the official factory/singleton release pairs', async () => {
    await expect(deploySafeSameAddress(TARGET_CHAIN, creation({ factory: MODULE }), SAFE))
      .rejects.toThrow(/recognized official factory and singleton pair/i);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it.each([
    ['singleton', { singleton: ALT_SINGLETON }, /singleton differs/i],
    ['fallback handler', { fallbackHandler: MODULE }, /fallback handler differs/i],
  ])('stops before sending when the live source %s differs from creation', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));
    const target = targetClient();
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(factorySimulationCalls(target)).toHaveLength(0);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('lets the caller bind governance verification to an explicit authority source chain', async () => {
    const arbitraryCreationSource = sourceClient({ threshold: 1n, owners: [OWNER_C] });
    const authoritySource = sourceClient();
    deployState.clients.set(SOURCE_CHAIN, arbitraryCreationSource);
    deployState.clients.set(AUTHORITY_SOURCE_CHAIN, authoritySource);
    deployState.clients.set(TARGET_CHAIN, targetClient());

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE, AUTHORITY_SOURCE_CHAIN)).resolves.toBe(HASH);
    expect(authoritySource.request).toHaveBeenCalled();
    expect(arbitraryCreationSource.request).not.toHaveBeenCalled();
  });

  it.each([
    ['missing official factory code', { factoryCode: '0x' }, /official Safe proxy factory.*bytecode/i],
    ['different singleton code', { destinationSingletonCode: '0x6009' }, /singleton bytecode does not match/i],
    ['different fallback-handler code', { destinationFallbackHandlerCode: '0x6009' }, /fallback handler bytecode does not match/i],
    ['a delegated fallback handler', { destinationFallbackHandlerCode: EIP_7702_CODE }, /delegated fallback handler/i],
    ['a contract owner', { contractOwners: [OWNER_A] }, /owner is a contract on the target chain/i],
    ['a prefixed non-7702 contract owner', { prefixedContractOwners: [OWNER_A] }, /owner is a contract on the target chain/i],
    ['an occupied Safe address', { occupied: true }, /already occupied/i],
    ['an unreadable Safe address', { targetAddressCode: null }, /malformed bytecode/i],
  ])('stops before simulation/write when the target has %s', async (_label, policy, error) => {
    const target = targetClient({ threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy });
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(factorySimulationCalls(target)).toHaveLength(0);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('requires the decoded factory simulation result to equal the expected Safe address', async () => {
    const target = targetClient({ threshold: 2n, owners: [OWNER_A, OWNER_B], simulatedAddress: OWNER_C });
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, target);

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(/unexpected proxy address.*nothing was sent/i);
    expect(factorySimulationCalls(target)).toHaveLength(1);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });

  it('fails closed after deployment when target governance differs from the source', async () => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, targetClient({ threshold: 1n, owners: [OWNER_A, OWNER_B] }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(/deployed Safe.*do not use/i);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('re-reads the source after receipt and rejects governance changed during deployment', async () => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], postThreshold: 1n,
    }));
    deployState.clients.set(TARGET_CHAIN, targetClient());

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(/recognized proxy, implementation, handler, owners, or threshold/i);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a transaction guard', { guardStorage: guardWord(MODULE) }, /transaction guard/i],
    ['an enabled module', { modules: [MODULE] }, /enabled modules/i],
  ])('fails closed after deployment when the target Safe has %s', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, targetClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['an unrecognized proxy runtime', { proxyCode: '0x6000' }, /official SafeProxy runtime/i],
    ['different singleton implementation code', { postSingletonCode: '0x6009' }, /recognized proxy, implementation, handler.*do not use/i],
    ['different fallback-handler implementation code', { postFallbackHandlerCode: '0x6009' }, /recognized proxy, implementation, handler.*do not use/i],
    ['a mismatched VERSION', { version: '9.9.9' }, /VERSION.*official singleton/i],
  ])('fails closed after deployment when the target has %s', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, targetClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['singleton', { singleton: ALT_SINGLETON }, /recognized proxy, implementation, handler.*do not use/i],
    ['fallback handler', { fallbackHandler: MODULE }, /recognized proxy, implementation, handler.*do not use/i],
  ])('fails closed after deployment when the target %s differs from source', async (_label, policy, error) => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, targetClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], ...policy,
    }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(error);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('fails closed after deployment when target identity storage is malformed', async () => {
    deployState.clients.set(SOURCE_CHAIN, sourceClient());
    deployState.clients.set(TARGET_CHAIN, targetClient({
      threshold: 2n, owners: [OWNER_A, OWNER_B], singletonStorage: '0x1234',
    }));

    await expect(deploySafeSameAddress(TARGET_CHAIN, creation(), SAFE)).rejects.toThrow(/verify Safe singleton/i);
    expect(deployState.wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('requires a creation record bound to a source chain', async () => {
    const unbound = creation();
    delete unbound.sourceChainId;
    await expect(deploySafeSameAddress(TARGET_CHAIN, unbound, SAFE)).rejects.toThrow(/missing its source chain/i);
    expect(deployState.wallet.writeContract).not.toHaveBeenCalled();
  });
});
