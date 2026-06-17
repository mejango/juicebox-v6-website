// src/wallet.js
// Wallet connection via viem — direct window.ethereum interaction
// No wagmi, no RainbowKit. Maximum simplicity for auditability.

import { createWalletClient, createPublicClient, custom, http } from 'viem';
import { CHAINS, getCurrentChainId, getCustomRpc, defaultRpcFor } from './chain.js';

let walletClient = null;
let publicClient = null;
let account = null;
const listeners = [];
const WALLET_FLAG = 'jb-wallet-connected'; // remember a prior connection so we can silently restore it

function setupClients(chain) {
  walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
  publicClient = createPublicClient({ chain, transport: custom(window.ethereum) });
}

export function getAccount() {
  return account;
}

export function getWalletClient() {
  return walletClient;
}

export function getPublicClient() {
  return publicClient;
}

export function onWalletChange(fn) {
  listeners.push(fn);
}

// Cached per (chain, RPC) so we don't spin up a fresh client on every read (e.g. each pay-preview
// keystroke). multicall batching folds concurrent reads into one RPC round-trip. Keyed by the custom
// RPC value too, so changing the RPC mid-session transparently yields a new client.
var _readClients = {};
export function createPublicClientForChain(chainId) {
  var chain = CHAINS[chainId];
  if (!chain) return null;
  var customRpc = getCustomRpc(chainId) || '';
  var key = chainId + '|' + customRpc;
  if (_readClients[key]) return _readClients[key];
  return (_readClients[key] = createPublicClient({
    chain: chain,
    transport: http(customRpc || defaultRpcFor(chainId)),
    batch: { multicall: { wait: 32 } },
  }));
}

function notify() {
  listeners.forEach(fn => fn({ account, connected: !!account }));
}

export async function connect() {
  if (!window.ethereum) {
    throw new Error('No wallet detected. Install MetaMask or another browser wallet.');
  }

  const chain = CHAINS[getCurrentChainId()] || CHAINS[11155111];

  setupClients(chain);

  const [addr] = await walletClient.requestAddresses();
  account = addr;
  try { localStorage.setItem(WALLET_FLAG, '1'); } catch (_) {}
  notify();
}

export async function disconnect() {
  walletClient = null;
  publicClient = null;
  account = null;
  try { localStorage.removeItem(WALLET_FLAG); } catch (_) {}
  notify();
}

// Silently restore a prior connection on page load — `eth_accounts` returns already-authorized
// accounts without prompting, so the user stays "connected" across refreshes.
export async function eagerConnect() {
  if (!window.ethereum) return;
  var wasConnected = false;
  try { wasConnected = localStorage.getItem(WALLET_FLAG) === '1'; } catch (_) {}
  if (!wasConnected) return;
  try {
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (accounts && accounts.length) {
      const chain = CHAINS[getCurrentChainId()] || CHAINS[11155111];
      setupClients(chain);
      account = accounts[0];
      notify();
    } else {
      try { localStorage.removeItem(WALLET_FLAG); } catch (_) {}
    }
  } catch (_) {}
}

export async function switchChain(chainId) {
  if (!window.ethereum) return;
  const chain = CHAINS[chainId];
  if (!chain) return;

  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + chainId.toString(16) }],
    });
  } catch (err) {
    // Chain not added to wallet — try adding it
    if (err.code === 4902 && chain) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x' + chainId.toString(16),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default ? [chain.rpcUrls.default.http[0]] : [],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : [],
        }],
      });
    } else {
      throw err;
    }
  }

  // Recreate clients for new chain
  walletClient = createWalletClient({
    chain,
    transport: custom(window.ethereum),
  });
  publicClient = createPublicClient({
    chain,
    transport: custom(window.ethereum),
  });
}

// Listen for account/chain changes from wallet
if (typeof window !== 'undefined' && window.ethereum) {
  window.ethereum.on('accountsChanged', (accounts) => {
    account = accounts[0] || null;
    if (account) {
      setupClients(CHAINS[getCurrentChainId()] || CHAINS[11155111]);
      try { localStorage.setItem(WALLET_FLAG, '1'); } catch (_) {}
    } else {
      walletClient = null; publicClient = null;
      try { localStorage.removeItem(WALLET_FLAG); } catch (_) {}
    }
    notify();
  });
  window.ethereum.on('chainChanged', () => {
    if (account) connect();
  });
}
