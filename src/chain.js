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
const listeners = [];

// CORS-enabled public RPCs for the mainnets — viem's defaults (eth.merkle.io etc.) block browser CORS,
// breaking reads. Testnets use viem defaults (they work in-browser). A user-set custom RPC overrides this.
const DEFAULT_RPC = {
  1: 'https://ethereum-rpc.publicnode.com',
  10: 'https://optimism-rpc.publicnode.com',
  8453: 'https://base-rpc.publicnode.com',
  42161: 'https://arbitrum-one-rpc.publicnode.com',
};
export function defaultRpcFor(chainId) {
  return DEFAULT_RPC[chainId] || undefined;
}

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

export function getManifestChains() {
  return manifest.chains;
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

// Storage access throws outright in blocked-storage contexts (Safari private windows, sandboxed
// Safe-App iframes) — degrade to "no override" like every other guarded storage site in the app.
export function getCustomRpc(chainId) {
  try { return localStorage.getItem('jb-rpc-' + chainId) || ''; } catch (_) { return ''; }
}

export function setCustomRpc(chainId, url) {
  try {
    if (url) localStorage.setItem('jb-rpc-' + chainId, url);
    else localStorage.removeItem('jb-rpc-' + chainId);
  } catch (_) {}
}
