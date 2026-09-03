// src/wallet.js
// Wallet connection via viem — direct window.ethereum interaction
// No wagmi, no RainbowKit. Maximum simplicity for auditability.

import { createWalletClient, createPublicClient, custom, fallback, http } from 'viem';
import { CHAINS, getCurrentChainId, getCustomRpc, readRpcUrlsFor } from './chain.js';
import { isMobileDevice } from './wallet-links.js';
import { detectSafeApp, makeSafeProvider, proposeSafeTransactions } from './safe-app.js';
export { proposeSafeTransactions } from './safe-app.js';

let walletClient = null;
let account = null;
let safeInfo = null;         // set when the site runs inside a Safe App iframe
let connectedViaSafe = false; // true once connected through the Safe provider — tx flow proposes to the queue
let safeInitialization = null;
export function isSafeConnected() { return connectedViaSafe; }
export function getSafeInfo() { return safeInfo; }
const listeners = [];
const WALLET_FLAG = 'jb-wallet-connected'; // remember a prior connection so we can silently restore it
const WALLET_RDNS = 'jb-wallet-rdns';      // which wallet (EIP-6963 rdns) to restore on refresh

// EIP-6963 multi-wallet discovery: wallets announce themselves so the user can pick which to connect.
// `activeProvider` is the one we actually talk to (defaults to the legacy injected `window.ethereum`).
const _providers = []; // [{ info: { uuid, name, icon, rdns }, provider }]
let activeProvider = (typeof window !== 'undefined' && window.ethereum) || null;
if (typeof window !== 'undefined') {
  // MetaMask Mobile can inject its provider after the app has loaded. It emits
  // this event once `window.ethereum` is ready; desktop extensions are already
  // present by the time this module runs.
  window.addEventListener('ethereum#initialized', function () {
    if (!activeProvider && window.ethereum) activeProvider = window.ethereum;
    requestProviderAnnouncements();
  });
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e && e.detail;
    if (!d || !d.info || !d.provider) return;
    if (!_providers.some(function (x) { return x.info.uuid === d.info.uuid; })) _providers.push(d);
  });
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
}

function requestProviderAnnouncements() {
  if (typeof window === 'undefined') return;
  try { window.dispatchEvent(new Event('eip6963:requestProvider')); } catch (_) {}
}

function walletNameForProvider(provider) {
  if (!provider) return 'Browser wallet';
  if (provider.isMetaMask) return 'MetaMask';
  if (provider.isCoinbaseWallet) return 'Coinbase Wallet';
  if (provider.isRabby) return 'Rabby';
  if (provider.isTrust) return 'Trust Wallet';
  if (provider.isBraveWallet) return 'Brave Wallet';
  return 'Browser wallet';
}

function walletRdnsForProvider(provider) {
  if (!provider) return 'injected';
  if (provider.isMetaMask) return 'io.metamask';
  if (provider.isCoinbaseWallet) return 'com.coinbase.wallet';
  if (provider.isRabby) return 'io.rabby';
  if (provider.isTrust) return 'com.trustwallet.app';
  if (provider.isBraveWallet) return 'com.brave.wallet';
  return 'injected';
}

function legacyProviders() {
  if (typeof window === 'undefined' || !window.ethereum) return [];
  var list = Array.isArray(window.ethereum.providers) && window.ethereum.providers.length
    ? window.ethereum.providers
    : [window.ethereum];
  var seen = [];
  return list.filter(function (p) {
    if (!p || seen.indexOf(p) !== -1) return false;
    seen.push(p);
    return true;
  }).map(function (provider, i) {
    return {
      info: { uuid: 'injected-' + i, name: walletNameForProvider(provider), rdns: walletRdnsForProvider(provider), icon: '' },
      provider: provider,
    };
  });
}

function safeProviderEntry() {
  if (!safeInfo) return null;
  var a = safeInfo.safeAddress;
  return { info: { uuid: 'safe-app', name: 'Safe (' + a.slice(0, 6) + '…' + a.slice(-4) + ')', rdns: 'global.safe', icon: '' }, provider: makeSafeProvider(safeInfo) };
}
// All detected wallets: the Safe first when in a Safe App, then EIP-6963 wallets (or a legacy injected entry).
export function getProviders() {
  var safe = safeProviderEntry();
  var rest = _providers.length ? _providers.slice() : legacyProviders();
  return safe ? [safe].concat(rest) : rest;
}

export function refreshProviders(waitMs) {
  requestProviderAnnouncements();
  return new Promise(function (resolve) {
    var settled = false;
    var timer;
    function finish() {
      if (settled) return;
      var providers = getProviders();
      if (!providers.length && timer) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof window !== 'undefined') {
        window.removeEventListener('ethereum#initialized', onProvider);
        window.removeEventListener('eip6963:announceProvider', onProvider);
      }
      resolve(providers);
    }
    function onProvider() {
      if (!activeProvider && typeof window !== 'undefined' && window.ethereum) activeProvider = window.ethereum;
      // Let an EIP-6963 announcement listener record its provider first.
      setTimeout(finish, 0);
    }
    if (getProviders().length) { finish(); return; }
    if (typeof window !== 'undefined') {
      window.addEventListener('ethereum#initialized', onProvider);
      window.addEventListener('eip6963:announceProvider', onProvider);
    }
    timer = setTimeout(function () {
      timer = null;
      finish();
    }, waitMs == null ? 350 : waitMs);
  });
}

function setupClients(chain) {
  walletClient = createWalletClient({ chain, transport: custom(activeProvider) });
}

export function getAccount() {
  return account;
}

export function getWalletClient() {
  return walletClient;
}

export function onWalletChange(fn) {
  listeners.push(fn);
  return function unsubscribeWalletChange() {
    var index = listeners.indexOf(fn);
    if (index !== -1) listeners.splice(index, 1);
  };
}

// Cached per (chain, RPC) so we don't spin up a fresh client on every read (e.g. each pay-preview
// keystroke). multicall batching folds concurrent reads into one RPC round-trip. Keyed by the custom
// RPC value too, so changing the RPC mid-session transparently yields a new client.
var _readClients = {};
// A read pinned to a block — `blockNumber: approvalReceipt.blockNumber`, how every approval step here
// proves its allowance landed — is answered with JSON-RPC -32001 by any node that has not imported that
// block yet. Public RPCs are load balanced, so the call right after a receipt can hit a sibling one block
// behind and fail a payment mid-flight, after the payer already paid gas for the approval. Waiting out the
// lag is the only correct answer: reading `latest` instead would answer from state older than the approval
// the pin exists to observe. Mainnets mine every 2-12s, so this schedule covers a few blocks of drift.
const BLOCK_LAG_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 2000];

function isBehindHead(error) {
  return !!error && typeof error === 'object' && (error.code === -32001 || (error.cause && error.cause.code === -32001));
}

// Retries only reads that a lagging node cannot answer yet. Writes go through the wallet client, never
// this transport, so a retry here can repeat work but never an effect. Exported for regression testing.
export function withBlockLagRetry(transport, delaysMs) {
  var delays = delaysMs || BLOCK_LAG_RETRY_DELAYS_MS;
  return function (options) {
    var instance = transport(options);
    var inner = instance.request;
    return Object.assign({}, instance, {
      request: async function (args) {
        for (var attempt = 0; ; attempt += 1) {
          try {
            return await inner(args);
          } catch (error) {
            if (attempt >= delays.length || !isBehindHead(error)) throw error;
            await new Promise(function (resolve) { setTimeout(resolve, delays[attempt]); });
          }
        }
      },
    });
  };
}

export function createPublicClientForChain(chainId) {
  var chain = CHAINS[chainId];
  if (!chain) return null;
  var customRpc = getCustomRpc(chainId) || '';
  var key = chainId + '|' + customRpc;
  if (_readClients[key]) return _readClients[key];
  // publicnode first, JB Center's keyless read gateway second. viem's fallback moves to the next
  // transport on transport/provider errors but rethrows execution reverts and user rejections at once,
  // so a revert is never re-run against the fallback. No default URL (a chain outside DEFAULT_RPC)
  // falls through to viem's own chain default.
  var urls = readRpcUrlsFor(chainId, customRpc);
  var transport = urls.length > 1 ? fallback(urls.map(function (url) { return http(url); })) : http(urls[0]);
  return (_readClients[key] = createPublicClient({
    chain: chain,
    transport: withBlockLagRetry(transport),
    batch: { multicall: { wait: 32 } },
  }));
}

// A stale/detached view must never prevent the rest of the app from learning about an account switch. Iterate a
// snapshot (subscriptions may change during a callback) and isolate callback failures. Exported for regression
// testing; notify() remains the only production caller.
export function dispatchWalletChangeListeners(callbacks, state, onError) {
  (callbacks || []).slice().forEach(function (fn) {
    try { fn(state); } catch (error) {
      if (onError) { try { onError(error); } catch (_) {} }
    }
  });
}

function notify() {
  dispatchWalletChangeListeners(listeners, { account: account, connected: !!account }, function (error) {
    if (typeof console !== 'undefined' && console.error) console.error('Wallet-change listener failed:', error);
  });
}

// Detect the Safe App context and, if present, auto-connect the Safe (a Safe App is already authorized by
// being opened inside Safe{Wallet}, so no manual connect step). Call once at startup, before eagerConnect.
export function initSafeApp() {
  if (safeInitialization) return safeInitialization;
  safeInitialization = (async function () {
    try { safeInfo = await detectSafeApp(); } catch (_) { safeInfo = null; }
    if (!safeInfo) return null;
    var chain = CHAINS[Number(safeInfo.chainId)] || CHAINS[getCurrentChainId()] || CHAINS[11155111];
    activeProvider = makeSafeProvider(safeInfo);
    connectedViaSafe = true;
    setupClients(chain);
    account = safeInfo.safeAddress;
    bindEvents(activeProvider);
    notify();
    return safeInfo;
  })();
  return safeInitialization;
}

// Transaction entry points await this before deciding between the Safe proposal
// path and the ordinary EOA path. It closes the first-load iframe race without
// making callers start a second, conflicting Safe probe.
export function waitForSafeInitialization() {
  return safeInitialization || initSafeApp();
}

export async function connect(chosen) {
  // `chosen` is an entry from getProviders() ({ info, provider }); when the user picks from the wallet
  // list we switch to that provider. Otherwise we use the current/active (legacy injected) provider.
  if (chosen && chosen.provider) {
    activeProvider = chosen.provider;
    connectedViaSafe = !!chosen.provider.isSafe;
    bindEvents(activeProvider);
    try { localStorage.setItem(WALLET_RDNS, (chosen.info && chosen.info.rdns) || ''); } catch (_) {}
  }
  if (!activeProvider && typeof window !== 'undefined' && window.ethereum) {
    activeProvider = window.ethereum;
  }
  if (!activeProvider && isMobileDevice(typeof navigator !== 'undefined' ? navigator : null)) {
    // MetaMask documents a late provider-injection path on mobile. Wait for
    // its initialization event before declaring that no wallet exists.
    var mobileProviders = await refreshProviders(3000);
    if (mobileProviders.length) {
      activeProvider = mobileProviders[0].provider;
      bindEvents(activeProvider);
    }
  }
  if (!activeProvider) {
    throw new Error('No wallet detected. Install MetaMask or another browser wallet.');
  }

  const chain = CHAINS[getCurrentChainId()] || CHAINS[11155111];
  setupClients(chain);

  // Desktop injected wallets can re-prompt account selection through wallet_requestPermissions. On mobile
  // wallet browsers this method is inconsistently implemented and can fail before the real connect prompt,
  // so mobile goes straight to eth_requestAccounts.
  var mobile = isMobileDevice(typeof navigator !== 'undefined' ? navigator : null);
  if (!mobile) {
    try {
      await activeProvider.request({ method: 'wallet_requestPermissions', params: [{ eth_accounts: {} }] });
    } catch (e) {
      if (e && e.code === 4001) throw e;
    }
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
    walletClient = null;
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
