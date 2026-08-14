import { namehash, normalize as ensNormalize } from 'viem/ens';
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData } from 'viem';

export const PROJECT_HANDLE_TEXT_KEY = 'juicebox';
export const JB_PROJECT_HANDLES_ADDRESS = '0x726f4a3dfd2fb8297f8ab98d215b42a92d8eefe8';
export const ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
export const ENS_NAME_WRAPPER_ADDRESS = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';

var ZERO_ADDRESS_RE = /^0x0{40}$/i;

export const ensRegistryResolverAbi = [{
  type: 'function', name: 'resolver', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }],
}];

export const ensRegistryOwnerAbi = [{
  type: 'function', name: 'owner', stateMutability: 'view',
  inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ type: 'address' }],
}];

export const ensNameWrapperAbi = [{
  type: 'function', name: 'ownerOf', stateMutability: 'view',
  inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ type: 'address' }],
}];

export const ensTextResolverAbi = [
  {
    type: 'function', name: 'text', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'setText', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ],
    outputs: [],
  },
];

export const projectHandlesAbi = [
  {
    type: 'function', name: 'ensNamePartsOf', stateMutability: 'view',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'setter', type: 'address' },
    ],
    outputs: [{ type: 'string[]' }],
  },
  {
    type: 'function', name: 'handleOf', stateMutability: 'view',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'setter', type: 'address' },
    ],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function', name: 'setEnsNamePartsFor', stateMutability: 'nonpayable',
    inputs: [
      { name: 'chainId', type: 'uint256' },
      { name: 'projectId', type: 'uint256' },
      { name: 'parts', type: 'string[]' },
    ],
    outputs: [],
  },
];

// JBProjectHandles accepts any exact .eth name chosen by a project's live authority. It stores labels from the
// .eth suffix inward: banny.eth is ["banny"], while docs.banny.eth is ["banny", "docs"]. The URL handle omits
// only the final .eth suffix; there is no shared or preselected namespace.
export function normalizeProjectHandle(value) {
  var input = String(value || '').trim().replace(/^@/, '');
  if (/\.eth$/i.test(input)) input = input.slice(0, -4);
  if (!input) throw new Error('Enter an ENS handle.');

  var ensName;
  try { ensName = ensNormalize(input + '.eth'); }
  catch (_) { throw new Error('Enter a valid ENS name.'); }

  var handle = ensName.slice(0, -4);
  var labels = handle.split('.');
  if (!handle || labels.some(function (label) { return !label || label === 'eth'; })) {
    throw new Error('Enter a valid ENS name without the .eth suffix.');
  }
  var encoder = new TextEncoder();
  if (labels.length > 32 || encoder.encode(handle).length > 256 || labels.some(function (label) {
    return encoder.encode(label).length > 255;
  })) throw new Error('This ENS name is too long for a project handle.');
  return { handle: handle, ensName: ensName, parts: labels.slice().reverse() };
}

export function projectHandleLocationUrl(documentUrl, value) {
  var base;
  try {
    var url = new URL(String(documentUrl || ''));
    url.hash = '';
    url.searchParams.delete('project');
    base = url.href;
  } catch (_) { base = String(documentUrl || '').replace(/#.*$/, ''); }
  var routeHandle = '<handle>';
  try { routeHandle = encodeURIComponent(normalizeProjectHandle(value).handle); } catch (_) {}
  return base + '#@' + routeHandle;
}

export function projectHandleLocationMessage(documentUrl, value) {
  return 'You’ll be able to find your project at ' + projectHandleLocationUrl(documentUrl, value);
}

// The Owner/Operator editor is one resumable flow with two separately reviewed Ethereum transactions. Pick the
// next transaction exclusively from live ENS state, so reopening the dialog after step one resumes at publish.
export function projectHandleEditorStep({ resolver, text, expectedText, selectedHandle, publishedHandle, ensQueued, publishQueued }) {
  if (!resolver) return { kind: 'resolver', label: 'Set a resolver in ENS Manager', enabled: false };
  if (text !== expectedText) {
    return {
      kind: 'ens',
      label: ensQueued ? 'Check ENS execution' : 'Set ENS record',
      enabled: true,
    };
  }
  if (selectedHandle && selectedHandle === publishedHandle) {
    return { kind: 'done', label: '@' + selectedHandle + ' is verified', enabled: false };
  }
  if (publishQueued) return { kind: 'publish-pending', label: 'Check handle execution', enabled: true };
  return {
    kind: 'publish',
    label: selectedHandle ? 'Publish @' + selectedHandle : 'Publish handle',
    enabled: !!selectedHandle,
  };
}

// Contract output is trusted only when it is already in canonical ENSIP-15 form. Normalizing an unsafe raw
// value into acceptance would make the client verify a different string from the one the contract returned.
export function canonicalProjectHandle(value) {
  if (typeof value !== 'string' || !value) return null;
  try { return normalizeProjectHandle(value).handle === value ? value : null; }
  catch (_) { return null; }
}

// ENS proves the reverse direction with the exact text value "chainId:projectId".
// Both numbers are constrained to JS-safe positive integers because the router
// hands them to the app's numeric chain/project identity model.
export function parseProjectHandleText(value) {
  var text = String(value || '');
  var match = /^([1-9]\d*):([1-9]\d*)$/.exec(text);
  if (!match || match[0] !== text) return null;
  var chainId = Number(match[1]);
  var projectId = Number(match[2]);
  if (!Number.isSafeInteger(chainId) || !Number.isSafeInteger(projectId)) return null;
  return { chainId: chainId, projectId: projectId };
}

export function projectHandleNode(ensName) {
  return namehash(ensNormalize(String(ensName || '').trim()));
}

// The ENS Registry owns unwrapped names directly. Wrapped names are owned by
// NameWrapper in the Registry, so their transaction authority is ownerOf(node).
// Never infer control from a resolver: resolver authorization is resolver-specific.
export async function readExactEnsController(client, ensName) {
  var node = projectHandleNode(ensName);
  var registryOwner = await client.readContract({
    address: ENS_REGISTRY_ADDRESS, abi: ensRegistryOwnerAbi, functionName: 'owner', args: [node],
  });
  if (!registryOwner || ZERO_ADDRESS_RE.test(registryOwner)) return null;
  if (registryOwner.toLowerCase() !== ENS_NAME_WRAPPER_ADDRESS.toLowerCase()) return registryOwner;

  var wrappedOwner;
  try {
    wrappedOwner = await client.readContract({
      address: ENS_NAME_WRAPPER_ADDRESS, abi: ensNameWrapperAbi,
      functionName: 'ownerOf', args: [BigInt(node)],
    });
  } catch (_) { return null; }
  return !wrappedOwner || ZERO_ADDRESS_RE.test(wrappedOwner) ? null : wrappedOwner;
}

export function projectHandleRecord(chainId, projectId) {
  return String(chainId) + ':' + String(projectId);
}

// Build only the resolver text write. In particular this helper never creates
// a setResolver transaction, so the exact Registry resolver stays pinned.
export function buildSetEnsProjectRecordCall({ resolver, ensName, chainId, projectId }) {
  var args = [projectHandleNode(ensName), PROJECT_HANDLE_TEXT_KEY, projectHandleRecord(chainId, projectId)];
  return {
    target: resolver,
    abi: ensTextResolverAbi,
    functionName: 'setText',
    args: args,
    data: encodeFunctionData({ abi: ensTextResolverAbi, functionName: 'setText', args: args }),
  };
}

// Recognize only the exact ENS resolver write produced by the project-handle editor. Other resolver calls are
// outside this integration and return null. This lets the pending-Safe surface re-check the current Registry
// resolver and exact Safe authorization long after the original proposal was queued.
export function decodeSetEnsProjectRecordCall({ target, data, value = 0, operation = 0 } = {}) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data) || (data.length - 2) / 2 > 4096) return null;
  var decoded;
  try { decoded = decodeFunctionData({ abi: ensTextResolverAbi, data: data }); }
  catch (_) { return null; }
  if (decoded.functionName !== 'setText' || !decoded.args || decoded.args.length !== 3 || decoded.args[1] !== PROJECT_HANDLE_TEXT_KEY) return null;
  if (typeof target !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(target)) throw new Error('The queued ENS resolver target is invalid.');
  var numericValue;
  try { numericValue = BigInt(value || 0); }
  catch (_) { throw new Error('The queued ENS resolver value is malformed.'); }
  if (Number(operation) !== 0 || numericValue !== 0n) throw new Error('Queued ENS text writes must be a zero-value CALL.');
  var canonical = encodeFunctionData({ abi: ensTextResolverAbi, functionName: 'setText', args: decoded.args });
  if (canonical.toLowerCase() !== data.toLowerCase()) throw new Error('The queued ENS text calldata is not canonical.');
  var tuple = parseProjectHandleText(decoded.args[2]);
  if (!tuple) throw new Error('The queued ENS project record is not an exact chainId:projectId tuple.');
  return {
    target: target, data: data, node: decoded.args[0], key: decoded.args[1], text: decoded.args[2],
    chainId: tuple.chainId, projectId: tuple.projectId,
  };
}

export function buildSetProjectHandleCall({ chainId, projectId, parts, address = JB_PROJECT_HANDLES_ADDRESS }) {
  var args = [BigInt(chainId), BigInt(projectId), parts];
  return {
    target: address,
    abi: projectHandlesAbi,
    functionName: 'setEnsNamePartsFor',
    args: args,
    data: encodeFunctionData({ abi: projectHandlesAbi, functionName: 'setEnsNamePartsFor', args: args }),
  };
}

// Recognize the one state-changing JBProjectHandles call that Juicescan may sign from an Ethereum Safe queue.
// The Safe Transaction Service is untrusted input: bound calldata size before decoding, require a normal CALL
// with no value, and require byte-for-byte canonical ABI encoding so trailing/ambiguous calldata is rejected.
// A non-JBProjectHandles target returns null; a malformed call to the canonical target fails closed.
export function decodeSetProjectHandleCall({ target, data, value = 0, operation = 0 } = {}) {
  if (typeof target !== 'string' || target.toLowerCase() !== JB_PROJECT_HANDLES_ADDRESS) return null;
  var numericOperation = Number(operation);
  var numericValue;
  try { numericValue = BigInt(value || 0); }
  catch (_) { throw new Error('The queued JBProjectHandles value is malformed.'); }
  if (numericOperation !== 0 || numericValue !== 0n) {
    throw new Error('Queued project-handle writes must be a zero-value CALL.');
  }
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(data) || (data.length - 2) / 2 > 4096) {
    throw new Error('The queued JBProjectHandles calldata is malformed or oversized.');
  }
  var decoded;
  try { decoded = decodeFunctionData({ abi: projectHandlesAbi, data: data }); }
  catch (_) { throw new Error('The queued JBProjectHandles call is not recognized.'); }
  if (decoded.functionName !== 'setEnsNamePartsFor' || !decoded.args || decoded.args.length !== 3) {
    throw new Error('The queued JBProjectHandles call is not recognized.');
  }
  var chainId = Number(decoded.args[0]), projectId = Number(decoded.args[1]), parts = decoded.args[2];
  if (!Number.isSafeInteger(chainId) || chainId < 1 || !Number.isSafeInteger(projectId) || projectId < 1) {
    throw new Error('The queued project-handle target is invalid.');
  }
  if (!Array.isArray(parts) || !parts.length || parts.length > 32 || parts.some(function (part) {
    return typeof part !== 'string' || !part || new TextEncoder().encode(part).length > 255;
  })) throw new Error('The queued project-handle name parts are invalid.');
  var normalized;
  try { normalized = normalizeProjectHandle(parts.slice().reverse().join('.')); }
  catch (_) { throw new Error('The queued project handle is not a canonical ENS name.'); }
  if (normalized.parts.length !== parts.length || normalized.parts.some(function (part, index) { return part !== parts[index]; })) {
    throw new Error('The queued project handle is not canonically encoded.');
  }
  var canonical = buildSetProjectHandleCall({ chainId: chainId, projectId: projectId, parts: parts });
  if (canonical.data.toLowerCase() !== data.toLowerCase()) throw new Error('The queued project-handle calldata is not canonical.');
  return {
    chainId: chainId, projectId: projectId, parts: parts.slice(),
    handle: normalized.handle, ensName: normalized.ensName,
    expectedText: projectHandleRecord(chainId, projectId),
  };
}

export async function readExactEnsResolverForNode(client, node) {
  if (typeof node !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(node)) throw new Error('The ENS node is malformed.');
  var resolver = await client.readContract({
    address: ENS_REGISTRY_ADDRESS, abi: ensRegistryResolverAbi, functionName: 'resolver', args: [node],
  });
  return !resolver || ZERO_ADDRESS_RE.test(resolver) ? null : resolver;
}

export function decodeBoundedEnsText(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-f]*$/i.test(data) || (data.length - 2) % 2) {
    throw new Error('The ENS resolver returned malformed text data.');
  }
  var byteLength = (data.length - 2) / 2;
  // Standard ABI for one string: offset + length + at most 256 padded bytes, matching JBProjectHandles' cap.
  if (byteLength < 64 || byteLength > 320) throw new Error('The ENS resolver returned oversized or malformed text data.');
  var offset, length;
  try {
    offset = BigInt(data.slice(0, 66));
    length = BigInt('0x' + data.slice(66, 130));
  } catch (_) { throw new Error('The ENS resolver returned malformed text data.'); }
  if (offset !== 32n || length > 256n) throw new Error('The ENS resolver returned oversized or malformed text data.');
  var expectedBytes = 64 + Math.ceil(Number(length) / 32) * 32;
  if (byteLength !== expectedBytes) throw new Error('The ENS resolver returned malformed text data.');
  return decodeFunctionResult({ abi: ensTextResolverAbi, functionName: 'text', data: data });
}

function decodeBoundedProjectHandlesResult(data, functionName, maxBytes) {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) {
    throw new Error('JBProjectHandles returned malformed data.');
  }
  var byteLength = (data.length - 2) / 2;
  if (!byteLength || byteLength > maxBytes) throw new Error('JBProjectHandles returned oversized data.');
  try { return decodeFunctionResult({ abi: projectHandlesAbi, functionName: functionName, data: data }); }
  catch (_) { throw new Error('JBProjectHandles returned malformed data.'); }
}

async function readBoundedProjectHandlesResult(client, functionName, chainId, projectId, setter, maxBytes, gas) {
  if (!client || typeof client.request !== 'function') throw new Error('The Ethereum RPC cannot make a bounded project-handle call.');
  var data = encodeFunctionData({
    abi: projectHandlesAbi, functionName: functionName,
    args: [BigInt(chainId), BigInt(projectId), setter],
  });
  var response = await client.request({
    method: 'eth_call',
    params: [{ to: JB_PROJECT_HANDLES_ADDRESS, data: data, gas: '0x' + BigInt(gas).toString(16) }, 'latest'],
  });
  return decodeBoundedProjectHandlesResult(response, functionName, maxBytes);
}

// These raw, CCIP-free reads cap both execution and decoded return data. A malicious setter can store many/large
// name parts, so generic readContract decoding is not safe on a route or editor hot path.
export function readProjectHandleBounded(client, chainId, projectId, setter) {
  return readBoundedProjectHandlesResult(client, 'handleOf', chainId, projectId, setter, 320, 250000n);
}

export async function readProjectHandlePartsBounded(client, chainId, projectId, setter) {
  var parts = await readBoundedProjectHandlesResult(client, 'ensNamePartsOf', chainId, projectId, setter, 4096, 150000n);
  if (!Array.isArray(parts) || parts.length > 32 || parts.some(function (part) {
    return typeof part !== 'string' || new TextEncoder().encode(part).length > 255;
  })) throw new Error('JBProjectHandles returned oversized name parts.');
  return parts;
}

// JBProjectHandles asks the ENS Registry for this exact node's resolver and calls
// text() on that address. Mirror that path exactly: Universal Resolver helpers may
// inherit a parent/wildcard resolver which the contract deliberately will not use.
export async function readExactEnsText(client, ensName, key = PROJECT_HANDLE_TEXT_KEY) {
  var node = projectHandleNode(ensName);
  return readExactEnsTextForNode(client, node, key);
}

export async function readExactEnsTextForNode(client, node, key = PROJECT_HANDLE_TEXT_KEY) {
  if (typeof node !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(node)) throw new Error('The ENS node is malformed.');
  var blockNumber = typeof client.getBlockNumber === 'function' ? await client.getBlockNumber() : null;
  var resolverRequest = {
    address: ENS_REGISTRY_ADDRESS, abi: ensRegistryResolverAbi, functionName: 'resolver', args: [node],
  };
  if (blockNumber !== null) resolverRequest.blockNumber = blockNumber;
  var resolver = await client.readContract(resolverRequest);
  if (!resolver || ZERO_ADDRESS_RE.test(resolver)) return { node: node, resolver: null, text: null };
  var data = encodeFunctionData({ abi: ensTextResolverAbi, functionName: 'text', args: [node, key] });
  // Use raw eth_call so viem cannot follow CCIP-read redirects from a name-owner-controlled resolver. The gas
  // limit includes transaction intrinsic gas, leaving approximately JBProjectHandles' 100k resolver stipend.
  // Supplying the canonical contract as `from` also preserves resolver behavior which depends on msg.sender.
  var response = await client.request({
    method: 'eth_call', params: [{
      from: JB_PROJECT_HANDLES_ADDRESS, to: resolver, data: data, gas: '0x1e848',
    }, blockNumber === null ? 'latest' : '0x' + blockNumber.toString(16)],
  });
  var text = decodeBoundedEnsText(response);
  return { node: node, resolver: resolver, text: text || null };
}

// Confirm the exact post-state after an executed setText transaction. Reading
// through readExactEnsText preserves the same direct resolver lookup, raw
// eth_call, gas stipend, return bound, and no-CCIP semantics as route checks.
export async function verifyEnsProjectRecord(client, {
  ensName, resolver, chainId, projectId,
}) {
  var confirmed = await readExactEnsText(client, ensName, PROJECT_HANDLE_TEXT_KEY);
  if (!confirmed.resolver || confirmed.resolver.toLowerCase() !== String(resolver).toLowerCase()) {
    throw new Error('The ENS resolver changed before the project record could be verified.');
  }
  var expected = projectHandleRecord(chainId, projectId);
  if (confirmed.text !== expected) {
    throw new Error('The ENS transaction confirmed, but the exact resolver project record is unchanged.');
  }
  return confirmed;
}

export function parseProjectHandleRoute(route) {
  var match = /^@([^/]+)(?:\/([a-z0-9]+))?(?:\/([a-z0-9]+))?$/iu.exec(String(route || '').trim());
  if (!match) return null;
  var decoded;
  try { decoded = decodeURIComponent(match[1]); }
  catch (_) { throw new Error('This project handle URL is malformed.'); }
  var normalized = normalizeProjectHandle(decoded);
  return {
    handle: normalized.handle,
    ensName: normalized.ensName,
    parts: normalized.parts,
    tab: match[2] ? match[2].toLowerCase() : null,
    subtab: match[3] ? match[3].toLowerCase() : null,
  };
}
