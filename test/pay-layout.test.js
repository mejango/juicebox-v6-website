import { describe, expect, it } from 'vitest';
import { payChainFontSize, payChainName } from '../src/discover.js';

describe('pay card chain label sizing', () => {
  it('keeps Base Sepolia at the standard size', () => {
    expect(payChainFontSize('Base Sepolia')).toBe(11);
  });

  it('uses the compact fallback only for unusually long names', () => {
    expect(payChainFontSize('An Extremely Long Network Name')).toBe(9);
  });

  it('uses concise testnet names in the pay sentence', () => {
    expect(payChainName(84532, 'Base Sepolia')).toBe('Base Sep');
    expect(payChainName(11155420, 'OP Sepolia')).toBe('OP Sep');
    expect(payChainName(421614, 'Arbitrum Sepolia')).toBe('Arb Sep');
  });
});
