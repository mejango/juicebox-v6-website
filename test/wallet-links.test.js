import { describe, expect, it } from 'vitest';
import { isMobileDevice, mobileWalletLinks, walletDappUrl } from '../src/wallet-links.js';

const CID = 'bafybeia7uzprpwhblgdlu5b6bqzd3wcfx2ef6zyczlk67253fttdky6kly';

describe('mobile wallet handoffs', () => {
  it('moves subdomain IPFS URLs to a gateway that wallet browsers can load', () => {
    expect(walletDappUrl('https://' + CID + '.ipfs.inbrowser.link/#base:1/pay')).toBe(
      'https://ipfs.io/ipfs/' + CID + '/#base:1/pay',
    );
    expect(walletDappUrl('https://' + CID + '.ipfs.dweb.link/#base:1/pay')).toBe(
      'https://ipfs.io/ipfs/' + CID + '/#base:1/pay',
    );
    expect(walletDappUrl('https://' + CID + '.ipfs.w3s.link/#base:1/pay')).toBe(
      'https://ipfs.io/ipfs/' + CID + '/#base:1/pay',
    );
  });

  it('preserves path, query, and hash when rewriting either inbrowser.link IPFS form', () => {
    var suffix = '/project/view?mode=compact#base:1';
    var expected = 'https://ipfs.io/ipfs/' + CID + suffix;
    expect(walletDappUrl('https://' + CID + '.ipfs.inbrowser.link' + suffix)).toBe(expected);
    expect(walletDappUrl('https://ipfs.inbrowser.link/ipfs/' + CID + suffix)).toBe(expected);
  });

  it('does not rewrite ordinary sites or already-compatible IPFS gateways', () => {
    expect(walletDappUrl('https://juicebox.money/#discover')).toBe('https://juicebox.money/#discover');
    expect(walletDappUrl('https://ipfs.io/ipfs/' + CID + '/#discover')).toBe(
      'https://ipfs.io/ipfs/' + CID + '/#discover',
    );
  });

  it('puts the rewritten URL into every supported wallet-app link', () => {
    var safe = 'https://ipfs.io/ipfs/' + CID + '/#discover';
    var links = mobileWalletLinks('https://' + CID + '.ipfs.inbrowser.link/#discover');
    expect(links.map(function (link) { return link.name; })).toEqual([
      'Open in MetaMask',
      'Open in Coinbase Wallet',
      'Open in Trust Wallet',
    ]);
    expect(decodeURIComponent(links[0].href.split('/dapp/')[1])).toBe(safe.replace(/^https?:\/\//, ''));
    expect(new URL(links[1].href).searchParams.get('cb_url')).toBe(safe);
    expect(new URL(links[2].href).searchParams.get('url')).toBe(safe);
  });

  it('recognizes iPhones and touch iPads without treating desktop Macs as mobile', () => {
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
  });
});
