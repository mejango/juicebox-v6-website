import { describe, expect, it } from 'vitest';
import { formatRawAdaptive, formatTokenCount, renderRoutingTag } from '../src/pay-preview.js';

describe('fixed-point display formatting', () => {
  it('keeps large balances out of lossy Number conversion', () => {
    expect(formatTokenCount(123456789012345678901234567890123456n)).toBe('123,456,789,012,345,678.90');
  });

  it('preserves zero-decimal tokens and rounds signed fixed-point values', () => {
    expect(formatRawAdaptive(12345678901234567890n, 0)).toBe('12,345,678,901,234,567,890');
    expect(formatRawAdaptive(-1500n, 3)).toBe('-1.50');
  });
});

describe('payment settlement labels', () => {
  it('calls every AMM-backed route a swap', () => {
    expect(renderRoutingTag('amm').textContent).toBe('Swap');
  });

  it('keeps direct terminal issuance distinct', () => {
    expect(renderRoutingTag('issuance').textContent).toBe('Issuance');
  });
});
