// The pay/swap/add-liquidity confirms pass a curated { name: value } args object (not a positional array).
// renderDecodedTx must render those values, not show empty fields. Regression for the "values not filled in" bug.
import { describe, it, expect } from 'vitest';
import { renderDecodedTx } from '../src/component-base.js';

describe('renderDecodedTx — named-object args render their values', () => {
  it('a pay-style payload (args = {name: value}) shows the values, not blanks', () => {
    const node = renderDecodedTx({
      chain: 'Ethereum', contract: 'JBMultiTerminal', address: '0x130f5dd2bd8805443cf41755253d778a75a67f53',
      'function': 'pay',
      args: { projectId: 5, token: '0x000000000000000000000000000000000000EEEe', amount: '1000000000000000000 (1 ETH)', beneficiary: '0xAbC0000000000000000000000000000000000001', minReturnedTokens: '0', memo: 'gm', metadata: '0x' },
    });
    const txt = node.textContent;
    expect(txt).not.toContain('Could not decode');
    expect(txt).toContain('projectId');
    expect(txt).toContain('5');
    expect(txt).toContain('1 ETH');
    expect(txt).toContain('0xAbC0000000000000000000000000000000000001'); // beneficiary value
    expect(txt).toContain('gm'); // memo value
  });
});
