import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  groupProjectDeployments,
  pidOn,
  projectIdsByChainFromSuckerGroup,
  resolveDiscoverIdentityRecord,
} from '../src/discover.js';

describe('cross-chain project identity', () => {
  it('waits for a cold live row instead of treating indexer latency as no sucker group', async () => {
    var resolveFresh;
    var fresh = new Promise((resolve) => { resolveFresh = resolve; });
    var pending = resolveDiscoverIdentityRecord(null, fresh);
    var settled = false;
    pending.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFresh({ suckerGroupId: 'group-a' });
    await expect(pending).resolves.toEqual({ suckerGroupId: 'group-a' });
  });

  it('can group delayed live rows into one omnichain card', async () => {
    const rows = await Promise.all([
      resolveDiscoverIdentityRecord(null, Promise.resolve({ suckerGroupId: 'group-a' })),
      resolveDiscoverIdentityRecord(null, Promise.resolve({ suckerGroupId: 'group-a' })),
    ]);
    const groups = groupProjectDeployments([
      { chainId: 1, projectId: 7, suckerGroupId: rows[0].suckerGroupId },
      { chainId: 10, projectId: 12, suckerGroupId: rows[1].suckerGroupId },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].idByChain).toEqual({ 1: 7, 10: 12 });
  });

  it('groups only deployments with the same verified sucker group', () => {
    const groups = groupProjectDeployments([
      { chainId: 1, projectId: 7, name: 'Ethereum', suckerGroupId: 'group-a' },
      { chainId: 10, projectId: 12, name: 'Optimism', suckerGroupId: 'group-a' },
      { chainId: 8453, projectId: 7, name: 'Base', suckerGroupId: null },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].idByChain).toEqual({ 1: 7, 10: 12 });
    expect(groups[0].chains.map((deployment) => deployment.projectId)).toEqual([7, 12]);
    expect(groups[1].idByChain).toEqual({ 8453: 7 });
  });

  it('fails closed when a non-home deployment has no verified local ID', () => {
    const project = { id: 7, chainId: 1, idByChain: { 1: 7, 10: 12 } };
    expect(pidOn(project, 1)).toBe(7n);
    expect(pidOn(project, 10)).toBe(12n);
    expect(() => pidOn(project, 8453)).toThrow(/Could not verify/);
  });

  it('keeps a sucker group conflict standalone on the ambiguous chain', () => {
    const groups = groupProjectDeployments([
      { chainId: 1, projectId: 7, suckerGroupId: 'group-a' },
      { chainId: 1, projectId: 8, suckerGroupId: 'group-a' },
      { chainId: 10, projectId: 12, suckerGroupId: 'group-a' },
    ]);

    expect(groups.map((group) => group.idByChain)).toEqual([
      { 1: 7 },
      { 1: 8 },
      { 10: 12 },
    ]);
  });

  it('drops a remote chain when a sucker group reports conflicting project IDs', () => {
    const byChain = projectIdsByChainFromSuckerGroup({
      suckerGroup: { projects: { items: [
        { chainId: 1, projectId: 7 },
        { chainId: 10, projectId: 12 },
        { chainId: 10, projectId: 99 },
      ] } },
    }, 1, 7);

    expect(byChain).toEqual({ 1: 7 });
  });

  it('rejects every remote mapping when the group conflicts with the route pair', () => {
    const byChain = projectIdsByChainFromSuckerGroup({
      suckerGroup: { projects: { items: [
        { chainId: 1, projectId: 99 },
        { chainId: 10, projectId: 12 },
      ] } },
    }, 1, 7);

    expect(byChain).toEqual({ 1: 7 });
  });

  it('does not combine one projectId with a multi-chain indexer filter', () => {
    const source = readFileSync('src/discover.js', 'utf8');
    expect(source).not.toMatch(/where:\s*\{[^}]*projectId[^}]*chainId_in/);
    expect(source).not.toMatch(/where:\s*\{[^}]*chainId_in[^}]*projectId/);
    expect(source).not.toMatch(/fetchProject\(project\.id,\s*urlChainId\)/);
  });
});
