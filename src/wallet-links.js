// src/wallet-links.js
// Pure mobile-wallet handoff helpers. Wallet apps open the dapp in their own browser, so the target URL must work
// there without relying on browser features (notably the Service Worker used by ipfs.inbrowser.link).

const WALLET_UNSAFE_IPFS_SUFFIXES = [
  '.ipfs.inbrowser.link',
  '.ipfs.dweb.link',
  '.ipfs.w3s.link',
];
const WALLET_IPFS_GATEWAY = 'https://ipfs.io';

function ipfsPathUrl(cid, pathname, search, hash) {
  return WALLET_IPFS_GATEWAY + '/ipfs/' + cid + (pathname || '/') + (search || '') + (hash || '');
}

export function walletDappUrl(href) {
  var raw = String(href || '');
  var url;
  try { url = new URL(raw); } catch (_) { return raw; }

  var hostname = url.hostname.toLowerCase();
  for (var i = 0; i < WALLET_UNSAFE_IPFS_SUFFIXES.length; i++) {
    var suffix = WALLET_UNSAFE_IPFS_SUFFIXES[i];
    if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
      var cid = hostname.slice(0, -suffix.length);
      return ipfsPathUrl(cid, url.pathname, url.search, url.hash);
    }
  }

  // Also handle the path-gateway form in case an inbrowser.link URL is shared that way.
  if (hostname === 'ipfs.inbrowser.link') {
    var match = /^\/ipfs\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (match) return ipfsPathUrl(match[1], match[2] || '/', url.search, url.hash);
  }

  return raw;
}

export function mobileWalletLinks(href) {
  var full = walletDappUrl(href);
  var dapp = encodeURIComponent(full.replace(/^https?:\/\//i, ''));
  return [
    { name: 'Open in MetaMask', href: 'https://metamask.app.link/dapp/' + dapp },
    { name: 'Open in Coinbase Wallet', href: 'https://go.cb-w.com/dapp?cb_url=' + encodeURIComponent(full) },
    { name: 'Open in Trust Wallet', href: 'https://link.trustwallet.com/open_url?coin_id=60&url=' + encodeURIComponent(full) },
  ];
}

export function isMobileDevice(nav) {
  if (!nav) return false;
  return /Android|iPhone|iPad|iPod/i.test(nav.userAgent || '')
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}
