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
const WALLET_RDNS = 'jb-wallet-rdns';      // which wallet (EIP-6963 rdns) to restore on refresh

// EIP-6963 multi-wallet discovery: wallets announce themselves so the user can pick which to connect.
// `activeProvider` is the one we actually talk to (defaults to the legacy injected `window.ethereum`).
const _providers = []; // [{ info: { uuid, name, icon, rdns }, provider }]
let activeProvider = (typeof window !== 'undefined' && window.ethereum) || null;
if (typeof window !== 'undefined') {
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e && e.detail;
    if (!d || !d.info || !d.provider) return;
    if (!_providers.some(function (x) { return x.info.uuid === d.info.uuid; })) _providers.push(d);
  });
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
}

// All detected wallets (EIP-6963), or a single generic entry for a legacy-only injected provider.
export function getProviders() {
  if (_providers.length) return _providers.slice();
  if (typeof window !== 'undefined' && window.ethereum) {
    return [{ info: { uuid: 'injected', name: 'Browser wallet', rdns: 'injected', icon: '' }, provider: window.ethereum }];
  }
  return [];
}

function setupClients(chain) {
  walletClient = createWalletClient({ chain, transport: custom(activeProvider) });
  publicClient = createPublicClient({ chain, transport: custom(activeProvider) });
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

export async function connect(chosen) {
  // `chosen` is an entry from getProviders() ({ info, provider }); when the user picks from the wallet
  // list we switch to that provider. Otherwise we use the current/active (legacy injected) provider.
  if (chosen && chosen.provider) {
    activeProvider = chosen.provider;
    bindEvents(activeProvider);
    try { localStorage.setItem(WALLET_RDNS, (chosen.info && chosen.info.rdns) || ''); } catch (_) {}
  }
  if (!activeProvider) {
    throw new Error('No wallet detected. Install MetaMask or another browser wallet.');
  }

  const chain = CHAINS[getCurrentChainId()] || CHAINS[11155111];
  setupClients(chain);

  // Re-request the `eth_accounts` permission so the wallet shows its account picker rather than silently
  // reusing the last grant. Only abort on an explicit user rejection (4001); other errors mean the wallet
  // doesn't implement it → fall through to eth_requestAccounts.
  try {
    await activeProvider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
  } catch (e) {
    if (e && e.code === 4001) throw e;
  }

  const accounts = await activeProvider.request({ method: 'eth_requestAccounts' });
  account = (accounts && accounts[0]) || null;
  bindEvents(activeProvider);
  try { localStorage.setItem(WALLET_FLAG, '1'); } catch (_) {}
  notify();
}

export async function disconnect() {
  // Revoke the dapp's account permission so the NEXT connect re-prompts the wallet's account picker
  // instead of silently re-granting the same account. Newer wallets support wallet_revokePermissions;
  // older ones don't — ignore failures.
  try {
    if (activeProvider) await activeProvider.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
  } catch (_) {}
  walletClient = null;
  publicClient = null;
  account = null;
  try { localStorage.removeItem(WALLET_FLAG); localStorage.removeItem(WALLET_RDNS); } catch (_) {}
  notify();
}

// Silently restore a prior connection on page load — `eth_accounts` returns already-authorized
// accounts without prompting, so the user stays "connected" across refreshes.
export async function eagerConnect() {
  var wasConnected = false;
  try { wasConnected = localStorage.getItem(WALLET_FLAG) === '1'; } catch (_) {}
  if (!wasConnected) return;
  // Restore the previously-chosen wallet (by EIP-6963 rdns) if it's still present; else fall back to the
  // legacy injected provider. Discovery announcements may land a tick after load, so retry briefly.
  var rdns = ''; try { rdns = localStorage.getItem(WALLET_RDNS) || ''; } catch (_) {}
  function pickByRdns() {
    if (rdns && rdns !== 'injected') {
      var m = _providers.filter(function (x) { return x.info.rdns === rdns; })[0];
      if (m) activeProvider = m.provider;
    }
  }
  pickByRdns();
  if (!activeProvider) { try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {} }
  if (!activeProvider) return;
  bindEvents(activeProvider);
  try {
    const accounts = await activeProvider.request({ method: 'eth_accounts' });
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
  if (!activeProvider) return;
  const chain = CHAINS[chainId];
  if (!chain) return;

  try {
    await activeProvider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x' + chainId.toString(16) }],
    });
  } catch (err) {
    // Chain not added to wallet — try adding it
    if (err.code === 4902 && chain) {
      await activeProvider.request({
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

  setupClients(chain); // recreate clients for the new chain on the active provider
}

// Wallet event handlers, (re)bound to whichever provider is active so switching wallets keeps them live.
let _boundProvider = null;
function onAccountsChanged(accounts) {
  account = (accounts && accounts[0]) || null;
  if (account) {
    setupClients(CHAINS[getCurrentChainId()] || CHAINS[11155111]);
    try { localStorage.setItem(WALLET_FLAG, '1'); } catch (_) {}
  } else {
    walletClient = null; publicClient = null;
    try { localStorage.removeItem(WALLET_FLAG); } catch (_) {}
  }
  notify();
}
function onChainChanged() {
  // Re-create clients silently for the app's selected chain — never re-prompt on a wallet chain switch.
  if (account) setupClients(CHAINS[getCurrentChainId()] || CHAINS[11155111]);
}
function bindEvents(p) {
  if (_boundProvider && _boundProvider.removeListener) {
    try {
      _boundProvider.removeListener('accountsChanged', onAccountsChanged);
      _boundProvider.removeListener('chainChanged', onChainChanged);
    } catch (_) {}
  }
  if (p && p.on) {
    try { p.on('accountsChanged', onAccountsChanged); p.on('chainChanged', onChainChanged); } catch (_) {}
  }
  _boundProvider = p;
}
if (typeof window !== 'undefined' && activeProvider) bindEvents(activeProvider);
