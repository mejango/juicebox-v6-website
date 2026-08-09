import { describe, expect, it } from 'vitest';
import { downsampleTimeSeries, smoothPriceSeries } from '../src/time-series.js';

describe('downsampleTimeSeries', () => {
  it('retains endpoints and a material spike in timestamp order', () => {
    const rows = Array.from({ length: 100 }, (_, timestamp) => ({
      timestamp,
      value: timestamp === 50 ? 10000 : timestamp,
    }));
    const sampled = downsampleTimeSeries(rows, 12, row => row.timestamp, row => row.value);
    expect(sampled).toHaveLength(12);
    expect(sampled[0]).toBe(rows[0]);
    expect(sampled.at(-1)).toBe(rows.at(-1));
    expect(sampled).toContain(rows[50]);
    expect(sampled.map(row => row.timestamp)).toEqual(
      [...sampled].map(row => row.timestamp).sort((a, b) => a - b)
    );
  });
});

describe('smoothPriceSeries', () => {
  it('attenuates a short-lived spike and preserves exact endpoints', () => {
    const smoothed = smoothPriceSeries([
      { timestamp: 0, value: 10 },
      { timestamp: 40, value: 100 },
      { timestamp: 41, value: 10 },
      { timestamp: 100, value: 10 },
    ]);

    expect(smoothed[0]).toEqual({ timestamp: 0, value: 10 });
    expect(smoothed.at(-1)).toEqual({ timestamp: 100, value: 10 });
    expect(Math.max(...smoothed.map(point => point.value))).toBeLessThan(20);
  });

  it('keeps sparse histories exact', () => {
    const points = [
      { timestamp: 0, value: 10 },
      { timestamp: 100, value: 12 },
    ];
    expect(smoothPriceSeries(points)).toEqual(points);
  });
});
