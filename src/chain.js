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

// Display order for the chains we ship UI for. This is an ORDER hint, not a membership list: chains present in
// the manifest but missing here are appended rather than dropped, so a newly deployed chain can never fall out
// of a picker or get classified as mainnet just because a hand-maintained copy wasn't updated.
const CHAIN_DISPLAY_ORDER = [1, 10, 42161, 8453, 11155111, 11155420, 84532, 421614];

/** Every chain in the deployment manifest as `{ id, name, testnet }`, in display order. */
export function chainList() {
  const chains = manifest.chains || {};
  const rank = id => {
    const index = CHAIN_DISPLAY_ORDER.indexOf(id);
    return index === -1 ? CHAIN_DISPLAY_ORDER.length : index;
  };
  return Object.keys(chains)
    .map(Number)
    .sort((a, b) => (rank(a) - rank(b)) || (a - b))
    .map(id => ({ id, name: chains[id].name, testnet: !!chains[id].testnet }));
}

/** The manifest's display name for a chain, or a plain `chain <id>` for anything it doesn't carry. */
export function chainNameFor(chainId) {
  const row = (manifest.chains || {})[String(chainId)];
  return (row && row.name) || ('chain ' + chainId);
}

/** Manifest-declared testnet flag. Keyed off the deployment data so a new testnet is never treated as mainnet. */
export function isTestnetChain(chainId) {
  const row = (manifest.chains || {})[String(chainId)];
  return !!(row && row.testnet);
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

// Canonical (Circle-issued) USDC per chain, lowercased to avoid viem checksum validation, derived from the one
// shipped token table. Consumption is split between display/pay paths and the create flow's IMMUTABLE sucker token
// mapping, so a chain present in one copy and absent from the other would either mislabel USDC or silently drop
// its bridge mapping — hence one source.
let _usdcByChain = null;
export function usdcByChain() {
  if (!_usdcByChain) {
    _usdcByChain = {};
    for (const chainId in tokens) {
      const row = (tokens[chainId] || []).find(token => token.symbol === 'USDC');
      if (row) _usdcByChain[Number(chainId)] = row.address.toLowerCase();
    }
  }
  return _usdcByChain;
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

// --- IPFS gateways -----------------------------------------------------------------------
// One list, one primary. discover.js races these when FETCHING metadata JSON; surfaces that
// can only emit a single URL (an <a href>, an <img src>) take the primary. Kept here, in a
// leaf module, because the copies that lived beside their callers drifted to a bare ipfs.io
// and went dark whenever that gateway 502'd while project pages kept working.
export var IPFS_PATH_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
  'https://ipfs.io/ipfs/',
];

/** An `ipfs://` URI as an HTTP URL on the primary gateway. Non-IPFS input is returned as-is. */
export function ipfsHttpUrl(uri) {
  var value = String(uri || '');
  if (value.indexOf('ipfs://') !== 0) return value;
  return IPFS_PATH_GATEWAYS[0] + value.slice('ipfs://'.length);
}
