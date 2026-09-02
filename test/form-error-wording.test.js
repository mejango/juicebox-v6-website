import { describe, expect, it } from 'vitest';
import { formatError } from '../src/form.js';

describe('API form error wording', () => {
  it('names a Permit2 allowance revert from outside the called ABI instead of printing its selector', () => {
    const err = { shortMessage: 'The contract function "addToBalanceOf" reverted with the following signature: 0xd81b2f2e', message: '' };
    expect(formatError(err, [{ type: 'function', name: 'addToBalanceOf', inputs: [], outputs: [] }])).toMatch(/permit2\.approve\(token, terminal/i);
  });

  it('keeps an ABI-decoded revert and the wallet rejection wording', () => {
    expect(formatError({ message: 'User rejected the request.' }, [])).toBe('Transaction rejected by wallet');
    expect(formatError({ shortMessage: 'boom' }, [])).toBe('boom');
  });
});
