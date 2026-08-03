import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

var source = readFileSync('src/discover.js', 'utf8');
var styles = readFileSync('src/style.css', 'utf8');

describe('Bendystraw project-row stale-then-confirm boundary', () => {
  it('persists only a network + chain + project key, never a wallet scope', () => {
    expect(source).toContain("var key = DISCOVER_NETWORK + ':' + chainId + ':' + id;");
    expect(source).toContain('cacheStale(BENDYSTRAW_PROJECT_CACHE_NAMESPACE, key');
  });

  it('requires live confirmation before a cached sucker group can reach cross-chain actions', () => {
    expect(source).toContain('var indexed = fetchFreshBendystrawProjectRecord(projectId, chainId);');
    expect(source).toContain('delete project.idByChain;');
    expect(source).toContain('project._transactionScopeConfirmed = false;');
  });

  it('marks every project-row display surface while its cached value is unconfirmed', () => {
    expect(source).toMatch(/discover-card[^\n]+_bendystrawRevalidating[^\n]+revalidating/);
    expect(source).toMatch(/project-detail-header[^\n]+_bendystrawRevalidating[^\n]+revalidating/);
    expect(source).toMatch(/detail-about-card[^\n]+_bendystrawRevalidating[^\n]+revalidating/);
    expect(styles).toMatch(/\.revalidating\s*\{[^}]*opacity:[^}]*animation:/s);
  });
});
