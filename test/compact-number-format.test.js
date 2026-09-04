// NUMBER PRESENTATION POLICY: dense lists abbreviate to THREE significant figures, never to
// whole units — "12k" for both 12,300 and 12,900 throws away an order of magnitude that
// "12.3k" reads just as fast. The exact value is always one hover away (exactTokenAmount).
import { describe, expect, it } from 'vitest';
import { formatCompactTokenAmount, exactTokenAmount } from '../src/discover.js';

const wei = (whole) => BigInt(whole) * 10n ** 18n;

describe('formatCompactTokenAmount', () => {
  it('keeps three significant figures across the ladder', () => {
    expect(formatCompactTokenAmount(wei(1234567890))).toBe('1.23b');
    expect(formatCompactTokenAmount(wei(12345678))).toBe('12.3m');
    expect(formatCompactTokenAmount(wei(123456))).toBe('123k');
    expect(formatCompactTokenAmount(wei(1234))).toBe('1.23k');
  });

  it('no longer collapses distinct magnitudes to one label', () => {
    // Both of these rendered "12k" before.
    expect(formatCompactTokenAmount(wei(12300))).not.toBe(
      formatCompactTokenAmount(wei(12900)),
    );
  });

  it('trims trailing zeros rather than padding', () => {
    expect(formatCompactTokenAmount(wei(1000))).toBe('1k');
    expect(formatCompactTokenAmount(wei(2000000))).toBe('2m');
    expect(formatCompactTokenAmount(wei(600000))).toBe('600k');
  });

  it('handles zero and absent values', () => {
    expect(formatCompactTokenAmount(0n)).toBe('0');
    expect(formatCompactTokenAmount(null)).toBe('—');
    expect(formatCompactTokenAmount(undefined)).toBe('—');
  });

  it('exposes the unabbreviated value for the hover', () => {
    expect(exactTokenAmount(wei(12345))).toContain('12,345');
    expect(exactTokenAmount(null)).toBe('');
  });
});
