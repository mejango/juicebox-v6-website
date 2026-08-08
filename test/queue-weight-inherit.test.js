// Queue-ruleset weight sentinel (P0-3): the hint promises "1 = inherit previous", but the default '1'
// ran through parseEther and encoded 1e18 (a fixed issuance of one token per unit). The inherit intent
// is the RAW integer 1 (JBRulesets weight sentinel). The field now defaults to blank = inherit (1n),
// and explicit numeric input means fixed-point tokens-per-unit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRulesetWeight, createDefaultRuleset, buildRulesetConfigs } from '../src/ruleset-config.js';

const E18 = 10n ** 18n;
const UINT112_MAX = (1n << 112n) - 1n;

describe('parseRulesetWeight — inherit sentinel vs fixed-point', () => {
  it('blank/null encodes the raw inherit sentinel 1n', () => {
    expect(parseRulesetWeight('')).toBe(1n);
    expect(parseRulesetWeight('   ')).toBe(1n);
    expect(parseRulesetWeight(null)).toBe(1n);
    expect(parseRulesetWeight(undefined)).toBe(1n);
  });

  it('launch mode: blank encodes an explicit 0n — a project\'s FIRST ruleset has nothing to inherit, and JBRulesets stores the sentinel 1 AS-IS (≈1 wei-token per unit), not 0', () => {
    expect(parseRulesetWeight('', 'launch')).toBe(0n);
    expect(parseRulesetWeight(null, 'launch')).toBe(0n);
    expect(parseRulesetWeight(undefined, 'launch')).toBe(0n);
    // Typed values are identical in both modes.
    expect(parseRulesetWeight('100', 'launch')).toBe(100n * E18);
    expect(parseRulesetWeight('0', 'launch')).toBe(0n);
  });

  it('explicit numbers are 18-dec fixed point: "100" => 100e18, "1" => 1e18, "0" => 0n', () => {
    expect(parseRulesetWeight('100')).toBe(100n * E18);
    expect(parseRulesetWeight('1')).toBe(E18);
    expect(parseRulesetWeight('0')).toBe(0n);
  });

  it('clamps huge values and degrades negatives to 0n', () => {
    expect(parseRulesetWeight('999999999999999999999999999999999999')).toBe(UINT112_MAX);
    expect(parseRulesetWeight('-1')).toBe(0n);
  });

  it('non-blank unparseable input throws (fail closed) instead of silently encoding zero issuance', () => {
    expect(() => parseRulesetWeight('abc')).toThrow(/Invalid issuance weight/);
    expect(() => parseRulesetWeight('1,000')).toThrow(/Invalid issuance weight/);
    expect(() => parseRulesetWeight('10e3')).toThrow(/Invalid issuance weight/);
    expect(() => parseRulesetWeight('1,000', 'launch')).toThrow(/Invalid issuance weight/);
  });
});

describe('queue ruleset config — default weight is inherit', () => {
  it('a queue-style default ruleset (blank weight) encodes weight 1n', () => {
    const rs = createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '' });
    expect(buildRulesetConfigs([rs])[0].weight).toBe(1n);
  });

  it('typed "100" encodes 100e18', () => {
    const rs = createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '100' });
    expect(buildRulesetConfigs([rs])[0].weight).toBe(100n * E18);
  });
});

describe('launch ruleset config — blank weight is an explicit 0, never the raw sentinel', () => {
  it('a launch-mode blank weight encodes 0n (no issuance) while queue mode keeps the sentinel', () => {
    const rs = createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '' });
    expect(buildRulesetConfigs([rs], { weightMode: 'launch' })[0].weight).toBe(0n);
    expect(buildRulesetConfigs([rs])[0].weight).toBe(1n);
  });

  it('typed weights encode identically in both modes', () => {
    const rs = createDefaultRuleset({ mustStartAtOrAfter: '0', weight: '100' });
    expect(buildRulesetConfigs([rs], { weightMode: 'launch' })[0].weight).toBe(100n * E18);
    expect(buildRulesetConfigs([rs])[0].weight).toBe(100n * E18);
  });
});

describe('launch component source — launch semantics wired in and hinted in the UI', () => {
  const src = readFileSync(resolve(process.cwd(), 'src/launch-component.js'), 'utf8');

  it('builds ruleset configs in launch weight mode', () => {
    expect(src).toMatch(/buildRulesetConfigs\(state\.rulesets,\s*\{\s*weightMode:\s*'launch'\s*\}\)/);
  });

  it('hints that blank means no issuance (mirroring the queue widget\'s blank hint)', () => {
    expect(src).toMatch(/blank or 0 = no issuance/);
  });
});

describe('queue component source — default state and hint match the sentinel semantics', () => {
  // The component renders through wallet/discovery scaffolding, so pin the source contract directly:
  // default field blank (inherit) and a hint that says blank = inherit, not "1 = inherit".
  const src = readFileSync(resolve(process.cwd(), 'src/queue-ruleset-component.js'), 'utf8');

  it('defaults the weight field to blank (inherit), not the fixed-point trap "1"', () => {
    expect(src).not.toMatch(/weight:\s*'1'/);
    expect(src).toMatch(/weight:\s*''/);
  });

  it('the hint no longer claims typed "1" inherits', () => {
    expect(src).not.toMatch(/1 = inherit/);
    expect(src).toMatch(/blank = inherit/);
  });
});
