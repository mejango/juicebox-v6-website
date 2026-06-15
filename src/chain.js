// src/chain.js
// Chain definitions and current chain state
// Uses viem chain definitions for RPC URLs and chain metadata

import { mainnet, optimism, arbitrum, base, sepolia, optimismSepolia, baseSepolia, arbitrumSepolia } from 'viem/chains';
import manifest from '../data/manifest.json';
import tokens from '../data/tokens.json';

export const CHAINS = {
  1: mainnet,
  10: optimism,
  42161: arbitrum,
  8453: base,
  11155111: sepolia,
  11155420: optimismSepolia,
  84532: baseSepolia,
  421614: arbitrumSepolia,
};

let currentChainId = 1; // Default to Ethereum mainnet
let showTestnets = false;
const listeners = [];

export function getCurrentChainId() {
  return currentChainId;
}

export function setCurrentChainId(id) {
  currentChainId = id;
  listeners.forEach(fn => fn(id));
}

export function onChainChange(fn) {
  listeners.push(fn);
}

export function getShowTestnets() {
  return showTestnets;
}

export function setShowTestnets(val) {
  showTestnets = val;
}

export function getManifestChains() {
  return manifest.chains;
}

export function getChainManifest(chainId) {
  return manifest.chains[String(chainId)] || null;
}

const NATIVE_NAMES = {};

export function getChainTokens(chainId) {
  const nativeName = NATIVE_NAMES[chainId] || 'ETH';
  const native = {
    symbol: `${nativeName} (native)`,
    address: '0x000000000000000000000000000000000000EEEe',
    decimals: 18,
  };
  const extras = (tokens[String(chainId)] || []).filter(function(t) {
    return t.address.toLowerCase() !== native.address.toLowerCase();
  });
  return [native, ...extras];
}

export function getContractAddress(contractName, chainId) {
  const contract = manifest.contracts[contractName];
  if (!contract || !contract.addresses) return null;
  return contract.addresses[String(chainId || currentChainId)] || null;
}

export function isContractSingleton(contractName) {
  const contract = manifest.contracts[contractName];
  return contract ? contract.singleton : true;
}

// Reverse map: lowercased address → contractName, across every chain in the manifest.
// JB contracts are mostly deterministic (same address on every chain), so a global map is safe.
let _addrToName = null;
export function contractNameByAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const a = address.toLowerCase();
  // Native token sentinel (NATIVE_TOKEN = 0x…EEEe) isn't a contract — label it plainly.
  if (a === '0x000000000000000000000000000000000000eeee') return 'Native token (ETH)';
  if (!_addrToName) {
    _addrToName = {};
    const cs = manifest.contracts || {};
    for (const name in cs) {
      const addrs = cs[name] && cs[name].addresses;
      if (!addrs) continue;
      for (const cid in addrs) {
        const v = addrs[cid];
        if (v) _addrToName[String(v).toLowerCase()] = cs[name].contractName || name;
      }
    }
  }
  return _addrToName[a] || null;
}

export function getCustomRpc(chainId) {
  return localStorage.getItem('jb-rpc-' + chainId) || '';
}

export function setCustomRpc(chainId, url) {
  if (url) localStorage.setItem('jb-rpc-' + chainId, url);
  else localStorage.removeItem('jb-rpc-' + chainId);
}
