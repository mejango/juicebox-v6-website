// Project payer address transaction boundary.
//
// Keep calldata construction isolated from the large Discover UI so reviewers can audit the exact ABI, validation,
// selector, and Relayr payload without following DOM state. The UI decides whether `owner` is zero (immutable) or
// nonzero (editable); this module faithfully validates and encodes either contract-supported mode.

import { encodeFunctionData, isAddress } from 'viem';
import { getAddress } from './abi-registry.js';
import { chainNameFor } from './chain.js';

export var PROJECT_PAYER_DEPLOY_ABI = [{
  type: 'function', name: 'deployProjectPayer', stateMutability: 'nonpayable',
  inputs: [
    { name: 'defaultProjectId', type: 'uint256' },
    { name: 'defaultBeneficiary', type: 'address' },
    { name: 'defaultMemo', type: 'string' },
    { name: 'defaultMetadata', type: 'bytes' },
    { name: 'defaultAddToBalance', type: 'bool' },
    { name: 'owner', type: 'address' },
  ],
  outputs: [{ name: 'projectPayer', type: 'address' }],
}];

function validAddress(value) {
  return typeof value === 'string' && isAddress(value, { strict: false });
}

function chainName(chainId) {
  return chainNameFor(chainId);
}

export function normalizeProjectPayerMetadata(metadata) {
  var hex = String(metadata || '').trim() || '0x';
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('Metadata must be hex bytes, e.g. 0x or 0x1234');
  return hex;
}

export function buildProjectPayerDeployArgs(projectId, beneficiary, memo, metadata, addToBalance, owner) {
  if (projectId == null || String(projectId) === '') throw new Error('Enter a project ID');
  if (!validAddress(beneficiary)) throw new Error('Enter a default beneficiary address');
  if (!validAddress(owner)) throw new Error('Enter the payer admin address');
  return [BigInt(projectId), beneficiary, String(memo || ''), normalizeProjectPayerMetadata(metadata), !!addToBalance, owner];
}

export function buildProjectPayerDeployCall(chainId, projectId, beneficiary, memo, metadata, addToBalance, owner) {
  var target = getAddress('JBProjectPayerDeployer', chainId);
  if (!target) throw new Error('No JBProjectPayerDeployer on ' + chainName(chainId));
  var args = buildProjectPayerDeployArgs(projectId, beneficiary, memo, metadata, addToBalance, owner);
  return {
    chainId: Number(chainId),
    to: target,
    abi: PROJECT_PAYER_DEPLOY_ABI,
    functionName: 'deployProjectPayer',
    args: args,
    data: encodeFunctionData({ abi: PROJECT_PAYER_DEPLOY_ABI, functionName: 'deployProjectPayer', args: args }),
  };
}

export function projectPayerRelayrEntry(call) {
  return { chain: Number(call.chainId), target: call.to, data: call.data, value: '0' };
}
