import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult } from 'viem';
import {
  buildSetEnsProjectRecordCall,
  buildSetProjectHandleCall,
  canonicalProjectHandle,
  decodeSetEnsProjectRecordCall,
  decodeSetProjectHandleCall,
  decodeBoundedEnsText,
  ENS_NAME_WRAPPER_ADDRESS,
  ENS_REGISTRY_ADDRESS,
  ensTextResolverAbi,
  JB_PROJECT_HANDLES_ADDRESS,
  normalizeProjectHandle,
  parseProjectHandleRoute,
  parseProjectHandleText,
  projectHandleEditorStep,
  projectHandleLocationMessage,
  PROJECT_HANDLE_TEXT_KEY,
  projectHandlesAbi,
  readExactEnsController,
  readExactEnsText,
  readProjectHandleBounded,
  readProjectHandlePartsBounded,
  verifyEnsProjectRecord,
} from '../src/project-handles.js';

describe('JBProjectHandles helpers', () => {
  it('accepts any project-selected .eth name without requiring a shared namespace', () => {
    expect(normalizeProjectHandle('banny.eth')).toEqual({
      handle: 'banny', ensName: 'banny.eth', parts: ['banny'],
    });
    expect(normalizeProjectHandle('docs.example.eth')).toEqual({
      handle: 'docs.example', ensName: 'docs.example.eth', parts: ['example', 'docs'],
    });
    expect(parseProjectHandleRoute('@banny')).toMatchObject({
      handle: 'banny', ensName: 'banny.eth', parts: ['banny'],
    });
  });

  it('normalizes the ENS name and reverses labels for the contract', () => {
    expect(normalizeProjectHandle('@Design.Juicebox.eth')).toEqual({
      handle: 'design.juicebox',
      ensName: 'design.juicebox.eth',
      parts: ['juicebox', 'design'],
    });
    expect(PROJECT_HANDLE_TEXT_KEY).toBe('juicebox');
  });

  it('describes the public project URL with the normalized current or draft handle', () => {
    expect(projectHandleLocationMessage('https://juicescan.io', '@Design.Juicebox.eth')).toBe(
      'You’ll be able to find your project at https://juicescan.io/@design.juicebox',
    );
    expect(projectHandleLocationMessage('https://juicescan.io/', 'banny.eth')).toBe(
      'You’ll be able to find your project at https://juicescan.io/@banny',
    );
    expect(projectHandleLocationMessage('https://juicescan.io', '')).toBe(
      'You’ll be able to find your project at https://juicescan.io/@<handle>',
    );
  });

  it('rejects malformed or ambiguous ENS names', () => {
    expect(() => normalizeProjectHandle('foo..bar')).toThrow(/valid ENS name/i);
    expect(() => normalizeProjectHandle('foo.eth.bar')).toThrow(/without the \.eth suffix/i);
    expect(() => normalizeProjectHandle('')).toThrow(/Enter an ENS handle/i);
  });

  it('rejects names the bounded route and queued-call readers cannot safely consume', () => {
    expect(normalizeProjectHandle(Array(32).fill('a').join('.') + '.eth').parts).toHaveLength(32);
    expect(normalizeProjectHandle('a'.repeat(127) + '.' + 'b'.repeat(127) + '.eth').handle).toHaveLength(255);
    expect(() => normalizeProjectHandle(Array(34).join('a.').slice(0, -1) + '.eth')).toThrow(/too long/i);
    expect(() => normalizeProjectHandle('a'.repeat(256) + '.eth')).toThrow(/too long|valid ENS/i);
    expect(() => normalizeProjectHandle('a'.repeat(128) + '.' + 'b'.repeat(128) + '.eth')).toThrow(/too long/i);
  });

  it('selects one resumable next action from the live ENS and published-handle state', () => {
    var base = { expectedText: '8453:42', selectedHandle: 'banny', publishedHandle: null };
    expect(projectHandleEditorStep({ ...base, resolver: null, text: null })).toEqual({
      kind: 'resolver', label: 'Set a resolver in ENS Manager', enabled: false,
    });
    expect(projectHandleEditorStep({ ...base, resolver: '0x1', text: null })).toEqual({
      kind: 'ens', label: 'Set ENS record', enabled: true,
    });
    expect(projectHandleEditorStep({ ...base, resolver: '0x1', text: null, ensQueued: true })).toEqual({
      kind: 'ens', label: 'Check ENS execution', enabled: true,
    });
    expect(projectHandleEditorStep({ ...base, resolver: '0x1', text: '8453:42' })).toEqual({
      kind: 'publish', label: 'Publish @banny', enabled: true,
    });
    expect(projectHandleEditorStep({ ...base, resolver: '0x1', text: '8453:42', publishQueued: true })).toEqual({
      kind: 'publish-pending', label: 'Check handle execution', enabled: true,
    });
    expect(projectHandleEditorStep({ ...base, resolver: '0x1', text: '8453:42', publishedHandle: 'banny' })).toEqual({
      kind: 'done', label: '@banny is verified', enabled: false,
    });
  });

  it('accepts contract output only when it is already the exact ENSIP-15 canonical handle', () => {
    expect(canonicalProjectHandle('design.juicebox')).toBe('design.juicebox');
    expect(canonicalProjectHandle('Design.Juicebox')).toBeNull();
    expect(canonicalProjectHandle('@design.juicebox')).toBeNull();
    expect(canonicalProjectHandle('design.juicebox.eth')).toBeNull();
    expect(canonicalProjectHandle(' design.juicebox')).toBeNull();
    expect(canonicalProjectHandle('design.\u2060juicebox')).toBeNull();
    expect(canonicalProjectHandle('e\u0301xample.juicebox')).toBeNull();
  });

  it('parses only exact positive safe chainId:projectId text records', () => {
    expect(parseProjectHandleText('8453:42')).toEqual({ chainId: 8453, projectId: 42 });
    expect(parseProjectHandleText('8453:42:1')).toBeNull();
    expect(parseProjectHandleText(' 8453:42')).toBeNull();
    expect(parseProjectHandleText('8453:42\n')).toBeNull();
    expect(parseProjectHandleText('0:42')).toBeNull();
    expect(parseProjectHandleText('1:9007199254740992')).toBeNull();
  });

  it('parses @handle routes while preserving tab suffixes', () => {
    expect(parseProjectHandleRoute('@Design.Juicebox/owner')).toEqual({
      handle: 'design.juicebox',
      ensName: 'design.juicebox.eth',
      parts: ['juicebox', 'design'],
      tab: 'owner',
      subtab: null,
    });
    expect(parseProjectHandleRoute('eth:1')).toBeNull();
  });

  it('reads the exact registry resolver instead of a wildcard/Universal Resolver', async () => {
    var resolver = '0x1111111111111111111111111111111111111111';
    var client = {
      readContract: vi.fn().mockResolvedValueOnce(resolver),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: ensTextResolverAbi, functionName: 'text', result: '8453:42',
      })),
    };
    await expect(readExactEnsText(client, 'design.juicebox.eth')).resolves.toMatchObject({
      resolver,
      text: '8453:42',
    });
    expect(client.readContract).toHaveBeenNthCalledWith(1, expect.objectContaining({
      address: ENS_REGISTRY_ADDRESS,
      functionName: 'resolver',
    }));
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'eth_call',
      params: [expect.objectContaining({
        from: JB_PROJECT_HANDLES_ADDRESS, to: resolver, gas: '0x1e848',
      }), 'latest'],
    }));
    // Raw eth_call intentionally bypasses viem's CCIP-read redirect handling.
    expect(client.readContract).toHaveBeenCalledTimes(1);
  });

  it('pins the Registry lookup and resolver call to one block when the client supports it', async () => {
    var resolver = '0x1111111111111111111111111111111111111111';
    var client = {
      getBlockNumber: vi.fn().mockResolvedValue(123n),
      readContract: vi.fn().mockResolvedValue(resolver),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: ensTextResolverAbi, functionName: 'text', result: '8453:42',
      })),
    };
    await readExactEnsText(client, 'design.juicebox.eth');
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(client.request).toHaveBeenCalledWith(expect.objectContaining({
      params: [expect.objectContaining({ from: JB_PROJECT_HANDLES_ADDRESS }), '0x7b'],
    }));
  });

  it('does not inherit a resolver when the exact registry node is unset', async () => {
    var client = { readContract: vi.fn().mockResolvedValue('0x0000000000000000000000000000000000000000') };
    await expect(readExactEnsText(client, 'design.juicebox.eth')).resolves.toMatchObject({ resolver: null, text: null });
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.request).toBeUndefined();
  });

  it('rejects malformed or oversized resolver returndata before ABI decoding', () => {
    var valid = encodeFunctionResult({ abi: ensTextResolverAbi, functionName: 'text', result: '8453:42' });
    var badOffset = '0x' + '0'.repeat(64) + valid.slice(66);
    expect(() => decodeBoundedEnsText(badOffset)).toThrow(/malformed/i);
    expect(() => decodeBoundedEnsText('0x' + '00'.repeat(321))).toThrow(/oversized/i);
    expect(decodeBoundedEnsText(valid)).toBe('8453:42');
  });

  it('bounds raw JBProjectHandles route/editor reads without CCIP handling', async () => {
    var setter = '0x2222222222222222222222222222222222222222';
    var client = { request: vi.fn(async function ({ method, params }) {
      expect(method).toBe('eth_call');
      var decoded = decodeFunctionData({ abi: projectHandlesAbi, data: params[0].data });
      if (decoded.functionName === 'handleOf') {
        expect(params[0].gas).toBe('0x3d090');
        return encodeFunctionResult({ abi: projectHandlesAbi, functionName: 'handleOf', result: 'design.juicebox' });
      }
      expect(params[0].gas).toBe('0x249f0');
      return encodeFunctionResult({ abi: projectHandlesAbi, functionName: 'ensNamePartsOf', result: ['juicebox', 'design'] });
    }) };
    await expect(readProjectHandleBounded(client, 8453, 42, setter)).resolves.toBe('design.juicebox');
    await expect(readProjectHandlePartsBounded(client, 8453, 42, setter)).resolves.toEqual(['juicebox', 'design']);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized JBProjectHandles returndata before decoding', async () => {
    var client = { request: vi.fn().mockResolvedValue('0x' + '00'.repeat(321)) };
    await expect(readProjectHandleBounded(client, 8453, 42, '0x2222222222222222222222222222222222222222'))
      .rejects.toThrow(/oversized/i);
  });

  it('fails the exact resolver read when raw eth_call returns oversized data', async () => {
    var client = {
      readContract: vi.fn().mockResolvedValue('0x1111111111111111111111111111111111111111'),
      request: vi.fn().mockResolvedValue('0x' + '00'.repeat(321)),
    };
    await expect(readExactEnsText(client, 'design.juicebox.eth')).rejects.toThrow(/oversized/i);
  });

  it('uses the exact Registry owner as an unwrapped ENS transaction controller', async () => {
    var owner = '0x2222222222222222222222222222222222222222';
    var client = { readContract: vi.fn().mockResolvedValue(owner) };
    await expect(readExactEnsController(client, 'design.juicebox.eth')).resolves.toBe(owner);
    expect(client.readContract).toHaveBeenCalledTimes(1);
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ENS_REGISTRY_ADDRESS,
      functionName: 'owner',
    }));
  });

  it('uses NameWrapper ownerOf(node) as a wrapped ENS transaction controller', async () => {
    var owner = '0x3333333333333333333333333333333333333333';
    var client = {
      readContract: vi.fn()
        .mockResolvedValueOnce(ENS_NAME_WRAPPER_ADDRESS)
        .mockResolvedValueOnce(owner),
    };
    await expect(readExactEnsController(client, 'design.juicebox.eth')).resolves.toBe(owner);
    expect(client.readContract).toHaveBeenNthCalledWith(2, expect.objectContaining({
      address: ENS_NAME_WRAPPER_ADDRESS,
      functionName: 'ownerOf',
      args: [expect.any(BigInt)],
    }));
  });

  it('treats zero or unreadable ENS ownership as having no transaction controller', async () => {
    var zero = '0x0000000000000000000000000000000000000000';
    await expect(readExactEnsController({ readContract: vi.fn().mockResolvedValue(zero) }, 'design.eth'))
      .resolves.toBeNull();
    var wrapped = {
      readContract: vi.fn().mockResolvedValueOnce(ENS_NAME_WRAPPER_ADDRESS).mockRejectedValueOnce(new Error('burned')),
    };
    await expect(readExactEnsController(wrapped, 'design.eth')).resolves.toBeNull();
  });

  it('builds only the exact resolver setText(node, juicebox, chainId:projectId) call', () => {
    var resolver = '0x1111111111111111111111111111111111111111';
    var call = buildSetEnsProjectRecordCall({
      resolver: resolver, ensName: 'design.juicebox.eth', chainId: 8453, projectId: 42,
    });
    expect(call.target).toBe(resolver);
    expect(call.functionName).toBe('setText');
    expect(decodeFunctionData({ abi: ensTextResolverAbi, data: call.data })).toEqual({
      functionName: 'setText',
      args: [call.args[0], PROJECT_HANDLE_TEXT_KEY, '8453:42'],
    });
  });

  it('builds the canonical authority-scoped JBProjectHandles publish call', () => {
    var call = buildSetProjectHandleCall({ chainId: 8453, projectId: 42, parts: ['juicebox', 'design'] });
    expect(call.target.toLowerCase()).toBe(JB_PROJECT_HANDLES_ADDRESS);
    expect(decodeFunctionData({ abi: projectHandlesAbi, data: call.data })).toEqual({
      functionName: 'setEnsNamePartsFor',
      args: [8453n, 42n, ['juicebox', 'design']],
    });
  });

  it('decodes only a canonical zero-value project-handle Safe call', () => {
    var call = buildSetProjectHandleCall({ chainId: 8453, projectId: 42, parts: ['juicebox', 'design'] });
    expect(decodeSetProjectHandleCall({ target: call.target, data: call.data, value: '0', operation: 0 })).toEqual({
      chainId: 8453, projectId: 42, parts: ['juicebox', 'design'],
      handle: 'design.juicebox', ensName: 'design.juicebox.eth', expectedText: '8453:42',
    });
    expect(decodeSetProjectHandleCall({ target: '0x1111111111111111111111111111111111111111', data: call.data })).toBeNull();
    expect(() => decodeSetProjectHandleCall({ target: call.target, data: call.data, value: '1' })).toThrow(/zero-value CALL/i);
    expect(() => decodeSetProjectHandleCall({ target: call.target, data: call.data, operation: 1 })).toThrow(/zero-value CALL/i);
    expect(() => decodeSetProjectHandleCall({ target: call.target, data: call.data + '00' })).toThrow(/canonical/i);
  });

  it('recognizes the exact juicebox ENS setText tuple for pending-Safe revalidation', () => {
    var resolver = '0x1111111111111111111111111111111111111111';
    var call = buildSetEnsProjectRecordCall({
      resolver: resolver, ensName: 'design.juicebox.eth', chainId: 8453, projectId: 42,
    });
    expect(decodeSetEnsProjectRecordCall({ target: resolver, data: call.data, value: '0', operation: 0 })).toMatchObject({
      target: resolver, node: call.args[0], key: 'juicebox', text: '8453:42', chainId: 8453, projectId: 42,
    });
    var unrelated = encodeFunctionData({
      abi: ensTextResolverAbi, functionName: 'setText', args: [call.args[0], 'avatar', 'ipfs://example'],
    });
    expect(decodeSetEnsProjectRecordCall({ target: resolver, data: unrelated })).toBeNull();
    expect(() => decodeSetEnsProjectRecordCall({ target: resolver, data: call.data, operation: 1 })).toThrow(/zero-value CALL/i);
  });

  it('verifies the exact resolver and record after an ENS write executes', async () => {
    var resolver = '0x1111111111111111111111111111111111111111';
    var client = {
      readContract: vi.fn().mockResolvedValue(resolver),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: ensTextResolverAbi, functionName: 'text', result: '8453:42',
      })),
    };
    await expect(verifyEnsProjectRecord(client, {
      ensName: 'design.juicebox.eth', resolver: resolver.toUpperCase(), chainId: 8453, projectId: 42,
    })).resolves.toMatchObject({ resolver: resolver, text: '8453:42' });
  });

  it('rejects an ENS write postcondition when the exact resolver or text changed', async () => {
    var expectedResolver = '0x1111111111111111111111111111111111111111';
    var changedResolver = '0x2222222222222222222222222222222222222222';
    var changed = {
      readContract: vi.fn().mockResolvedValue(changedResolver),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: ensTextResolverAbi, functionName: 'text', result: '8453:42',
      })),
    };
    await expect(verifyEnsProjectRecord(changed, {
      ensName: 'design.juicebox.eth', resolver: expectedResolver, chainId: 8453, projectId: 42,
    })).rejects.toThrow(/resolver changed/i);

    var stale = {
      readContract: vi.fn().mockResolvedValue(expectedResolver),
      request: vi.fn().mockResolvedValue(encodeFunctionResult({
        abi: ensTextResolverAbi, functionName: 'text', result: '1:1',
      })),
    };
    await expect(verifyEnsProjectRecord(stale, {
      ensName: 'design.juicebox.eth', resolver: expectedResolver, chainId: 8453, projectId: 42,
    })).rejects.toThrow(/record is unchanged/i);
  });
});
