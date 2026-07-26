import { describe, expect, it } from 'vitest';
import { payChainFontSize } from '../src/discover.js';

describe('pay card chain label sizing', () => {
  it('keeps Base Sepolia at the standard size', () => {
    expect(payChainFontSize('Base Sepolia')).toBe(11);
  });

  it('uses the compact fallback only for unusually long names', () => {
    expect(payChainFontSize('An Extremely Long Network Name')).toBe(9);
  });
});
