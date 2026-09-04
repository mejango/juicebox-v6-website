import { describe, expect, it } from 'vitest';
import { buildTxDebugPrompt } from '../src/component-base.js';

describe('buildTxDebugPrompt', () => {
  it('links each tx on its own explorer and points at the Etherscan debugger skill', () => {
    const prompt = buildTxDebugPrompt([
      { chainId: 1, txHash: '0xabc' },
      { chainId: 8453, txHash: '0xdef' },
    ]);
    expect(prompt).toContain('https://etherscan.io/tx/0xabc');
    expect(prompt).toContain('https://basescan.org/tx/0xdef');
    expect(prompt).toContain('etherscan-transaction-debugger');
    expect(prompt).toContain('Bananapus/version-6');
  });
});
