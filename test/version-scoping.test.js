// Version scoping: this is a V6 explorer, so every bendystraw selection that CAN be version-filtered must
// be, and the one entity that can't (wallet — no version field in the schema) must say so honestly in its
// DATA-tab copy instead of presenting lifetime cross-version totals as V6 numbers.
import { describe, it, expect } from 'vitest';
import { BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY, projectIdsByChainFromSuckerGroup } from '../src/discover.js';
import queriesJson from '../data/bendystraw-queries.json';

describe('sucker-group projects selection', () => {
  it('filters the nested projects selection to version 6 and selects version for client-side defense', () => {
    expect(BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY).toMatch(/projects\(where: \{ version: 6 \}/);
    expect(BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY).toMatch(/items \{[^}]*version[^}]*\}/);
  });

  it('does not silently paginate at 100', () => {
    expect(BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY).not.toMatch(/limit: 100\b/);
    expect(BENDYSTRAW_SUCKER_GROUP_PROJECTS_QUERY).toMatch(/limit: 1000\b/);
  });

  it('ignores non-V6 rows client-side', () => {
    const data = { suckerGroup: { projects: { items: [
      { chainId: 10, projectId: 5, version: 6 },
      { chainId: 8453, projectId: 7, version: 5 }, // other-version row must not map
      { chainId: 42161, projectId: 9, version: 6 },
    ] } } };
    expect(projectIdsByChainFromSuckerGroup(data, 10, 5)).toEqual({ 10: 5, 42161: 9 });
  });

  it('a non-V6 conflicting row on the home chain cannot poison the V6 mapping', () => {
    const data = { suckerGroup: { projects: { items: [
      { chainId: 10, projectId: 99, version: 5 },
      { chainId: 8453, projectId: 7, version: 6 },
    ] } } };
    expect(projectIdsByChainFromSuckerGroup(data, 10, 5)).toEqual({ 10: 5, 8453: 7 });
  });

  it('still accepts rows without a version field (server already filtered)', () => {
    const data = { suckerGroup: { projects: { items: [{ chainId: 8453, projectId: 7 }] } } };
    expect(projectIdsByChainFromSuckerGroup(data, 10, 5)).toEqual({ 10: 5, 8453: 7 });
  });

  it('fails closed to the exact route deployment when the page limit is hit (possible truncation)', () => {
    const items = [];
    for (let i = 0; i < 1000; i++) items.push({ chainId: 100000 + i, projectId: i + 1, version: 6 });
    const data = { suckerGroup: { projects: { items } } };
    expect(projectIdsByChainFromSuckerGroup(data, 10, 5)).toEqual({ 10: 5 });
  });
});

describe('wallet-portfolio DATA-tab honesty', () => {
  const query = queriesJson.sections
    .flatMap((section) => section.queries || [])
    .find((entry) => entry.id === 'wallet-portfolio');

  it('labels the un-scopeable wallet entity as spanning all versions', () => {
    expect(query).toBeTruthy();
    expect(query.hint).toMatch(/all .*versions/i);
    const volume = query.columns.find((column) => column.key === 'volume');
    const volumeUsd = query.columns.find((column) => column.key === 'volumeUsd');
    expect(volume.label).toMatch(/all versions/i);
    expect(volumeUsd.label).toMatch(/all versions/i);
  });
});
