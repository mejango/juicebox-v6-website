import { describe, it, expect } from 'vitest';
import { authorityRowsDiverged, projectAuthorityUnavailable } from '../src/discover.js';

describe('authorityRowsDiverged', () => {
  it('detects per-chain operator or owner splits', () => {
    expect(authorityRowsDiverged([
      { chainId: 11155111, owner: '0x1111111111111111111111111111111111111111' },
      { chainId: 421614, owner: '0x1111111111111111111111111111111111111111' },
      { chainId: 11155420, owner: '0x2222222222222222222222222222222222222222' },
    ])).toBe(true);
  });

  it('treats uniform known rows as not diverged', () => {
    expect(authorityRowsDiverged([
      { chainId: 11155111, owner: '0x1111111111111111111111111111111111111111' },
      { chainId: 421614, owner: '0x1111111111111111111111111111111111111111' },
    ])).toBe(false);
  });

  it('ignores unknown rows when comparing known authorities', () => {
    expect(authorityRowsDiverged([
      { chainId: 11155111, owner: '0x1111111111111111111111111111111111111111' },
      { chainId: 421614, owner: null },
    ])).toBe(false);
    // A row the indexer could not be read for must not be mistaken for a differing authority either.
    expect(authorityRowsDiverged([
      { chainId: 11155111, owner: '0x1111111111111111111111111111111111111111' },
      { chainId: 421614, owner: null, unavailable: true },
    ])).toBe(false);
  });
});

describe('projectAuthorityUnavailable', () => {
  it('separates an unread operator from a genuinely absent one', () => {
    // A revnet always has an operator, so a blank one with a failed read is "could not load", never "none".
    expect(projectAuthorityUnavailable({ isRevnet: true, operator: null, operatorUnavailable: true })).toBe(true);
    expect(projectAuthorityUnavailable({ isRevnet: true, operator: null })).toBe(false);
    expect(projectAuthorityUnavailable({
      isRevnet: true,
      operator: '0x1111111111111111111111111111111111111111',
      operatorUnavailable: true,
    })).toBe(false);
    // Custom projects read their owner on-chain; the operator flag never applies.
    expect(projectAuthorityUnavailable({ isRevnet: false, owner: null, operatorUnavailable: true })).toBe(false);
    expect(projectAuthorityUnavailable(null)).toBe(false);
  });
});
