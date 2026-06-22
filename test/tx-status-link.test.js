// The "Confirming onchain | 0x…" status must link the tx hash to the right chain's block explorer.
import { describe, it, expect } from 'vitest';
import { setStatusContent, txExplorerUrl, truncAddr } from '../src/component-base.js';

const HASH = '0x4d56' + 'a'.repeat(56) + 'f3d4';

describe('tx status hash → block-explorer link', () => {
  it('txExplorerUrl points at the chain explorer', () => {
    expect(txExplorerUrl(1, HASH)).toBe('https://etherscan.io/tx/' + HASH);
    expect(txExplorerUrl(8453, HASH)).toContain('/tx/' + HASH); // Base
  });
  it('setStatusContent makes the truncated hash a clickable explorer link', () => {
    const trunc = truncAddr(HASH);
    const el = document.createElement('div');
    setStatusContent(el, 'Confirming onchain | ' + trunc, { hash: HASH, chainId: 1 });
    const a = el.querySelector('a.tx-status-hash');
    expect(a).not.toBeNull();
    expect(a.textContent).toBe(trunc);
    expect(a.getAttribute('href')).toBe('https://etherscan.io/tx/' + HASH);
    expect(a.getAttribute('target')).toBe('_blank');
    expect(el.textContent).toContain('Confirming onchain');
  });
  it('falls back to plain text with no meta', () => {
    const el = document.createElement('div');
    setStatusContent(el, 'Awaiting wallet confirmation...', undefined);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toBe('Awaiting wallet confirmation...');
  });
});
