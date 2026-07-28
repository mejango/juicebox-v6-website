// The Rulesets tab's read-only "Past rulesets" table rows: id/start/weight/duration/tax from the
// controller's allRulesetsOf entries, newest first, no projections.
import { describe, expect, it } from 'vitest';
import { pastRulesetRows } from '../src/discover.js';

describe('pastRulesetRows', () => {
  it('maps {ruleset, metadata} entries and sorts newest first', () => {
    const rows = pastRulesetRows([
      { ruleset: { id: 100n, cycleNumber: 1n, start: 1000n, weight: 10n ** 21n, duration: 86400n }, metadata: { cashOutTaxRate: 2500n } },
      { ruleset: { id: 200n, cycleNumber: 2n, start: 2000n, weight: 5n * 10n ** 20n, duration: 0n }, metadata: { cashOutTaxRate: 0n } },
    ]);
    expect(rows.map(r => r.id)).toEqual(['200', '100']);
    expect(rows[1]).toMatchObject({ start: 1000, weight: 1000, duration: 86400, tax: 25 });
    expect(rows[0]).toMatchObject({ start: 2000, weight: 500, duration: 0, tax: 0 });
  });

  it('tolerates bare rulesets (no metadata) with a null tax', () => {
    const rows = pastRulesetRows([{ id: 7, start: 5, weight: 1e18, duration: 0 }]);
    expect(rows[0].tax).toBeNull();
    expect(rows[0].weight).toBe(1);
  });

  it('returns [] for empty/absent input', () => {
    expect(pastRulesetRows(null)).toEqual([]);
    expect(pastRulesetRows([])).toEqual([]);
  });
});
