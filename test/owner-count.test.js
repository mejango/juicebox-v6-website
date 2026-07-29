import { describe, expect, it } from 'vitest';
import { ownerCountText } from '../src/discover.js';

describe('token-holder count truthfulness', () => {
  it('renders exact counts without qualification', () => {
    expect(ownerCountText({ count: 42, exact: true, totalCount: 42 })).toBe('42');
  });

  it('marks bounded counts as a lower bound', () => {
    expect(ownerCountText({ count: 731, exact: false, totalCount: 1200 })).toBe('731+');
  });

  it('never turns an unavailable count into zero', () => {
    expect(ownerCountText(null)).toBe('—');
  });
});
