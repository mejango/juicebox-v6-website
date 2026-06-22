// Tier media URLs come from attacker-controlled project/NFT metadata. safeMediaUrl must strip script-bearing
// schemes before they reach a src/href; httpUrlOnly gates the PDF <iframe> (which executes its src) to real URLs.
// Regression for the confirmed XSS findings (iframe src + tierMediaBadge href).
import { describe, it, expect } from 'vitest';
import { safeMediaUrl, httpUrlOnly } from '../src/discover.js';

describe('safeMediaUrl — blocks script schemes, keeps real media', () => {
  it('drops javascript:/vbscript:/blob:', () => {
    expect(safeMediaUrl('javascript:alert(1)')).toBe('');
    expect(safeMediaUrl('  JavaScript:alert(1)')).toBe(''); // trims + case-insensitive
    expect(safeMediaUrl('vbscript:msgbox(1)')).toBe('');
    expect(safeMediaUrl('blob:https://evil/x')).toBe('');
  });
  it('drops data:text/html and data:application (HTML/script payloads)', () => {
    expect(safeMediaUrl('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(safeMediaUrl('data:application/javascript,alert(1)')).toBe('');
  });
  it('keeps http(s), ipfs gateway, and data:image|video|audio', () => {
    expect(safeMediaUrl('https://gw/ipfs/Qm')).toBe('https://gw/ipfs/Qm');
    expect(safeMediaUrl('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR');
    expect(safeMediaUrl('data:video/mp4;base64,AAA')).toBe('data:video/mp4;base64,AAA');
  });
  it('empty in → empty out', () => { expect(safeMediaUrl('')).toBe(''); expect(safeMediaUrl(null)).toBe(''); });
});

describe('httpUrlOnly — the PDF iframe gate (no data:/blob:/javascript: ever embeds)', () => {
  it('only http(s) passes', () => {
    expect(httpUrlOnly('https://gw/ipfs/Qm/doc.pdf')).toBe('https://gw/ipfs/Qm/doc.pdf');
    expect(httpUrlOnly('http://x/doc.pdf')).toBe('http://x/doc.pdf');
  });
  it('rejects data:/blob:/javascript: (the iframe XSS vectors)', () => {
    expect(httpUrlOnly('data:text/html,<script>alert(1)</script>')).toBe('');
    expect(httpUrlOnly('javascript:alert(1)')).toBe('');
    expect(httpUrlOnly('blob:https://evil/x')).toBe('');
    expect(httpUrlOnly('ipfs://Qm')).toBe(''); // must be resolved to a gateway URL first
  });
});
