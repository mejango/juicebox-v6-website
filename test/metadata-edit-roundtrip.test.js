// Operator feedback (kmac88 / FEPL): the project-metadata editor must never step on extended metadata.
// Their projectUri carries custom keys (a `leagueID`) the form doesn't know about; a save that rebuilds
// the JSON from known fields would destroy them. The editor merges edits over the LIVE projectUri JSON:
// untouched fields keep whatever the live JSON has, only operator-touched fields are overwritten, and a
// touched-but-emptied field is an explicit clear. The modal also surfaces a Payment notice (payDisclosure)
// editor and an "Advanced — custom properties (JSON)" expandable: an open-ended JSON textarea prefilled
// with the unmanaged keys, whose parsed object REPLACES the unmanaged-key set on save (managed form
// fields win on collision; invalid JSON blocks the save; the textarea fails closed until the live JSON loads).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  mergeProjectMetadataEdit, unmanagedProjectMetadataKeys,
  parseProjectCustomProperties, projectCustomPropertiesText,
} from '../src/discover.js';

const discoverSrc = readFileSync(resolve(process.cwd(), 'src/discover.js'), 'utf8');
const createSrc = readFileSync(resolve(process.cwd(), 'src/create-flow.js'), 'utf8');

const LIVE = Object.freeze({
  name: 'FEPL',
  projectTagline: 'Fantasy EPL',
  description: '<p>Hi <strong>there</strong></p>',
  infoUri: 'https://fepl.xyz',
  logoUri: 'ipfs://bafylogo',
  payDisclosure: 'Entry fees are final.',
  leagueID: 'FEPL-2026',
  tags: ['fantasy', 'epl'],
  extensions: { fepl: { season: 2026, teams: [1, 2, 3] } },
  version: 6,
});

describe('mergeProjectMetadataEdit — custom keys survive edits byte-for-key', () => {
  it('a name-only edit keeps leagueID, tags, and a nested unknown object identical', () => {
    const out = mergeProjectMetadataEdit(LIVE, [
      { key: 'name', value: 'FEPL League', dirty: true },
      // The rest of the form was rendered but never touched — even where the re-rendered value would
      // differ from the live JSON (description text→html round-trip), untouched must mean untouched.
      { key: 'projectTagline', value: 'Fantasy EPL', dirty: false },
      { key: 'description', value: '<p>Hi there</p>', dirty: false },
      { key: 'infoUri', value: 'https://fepl.xyz', dirty: false },
      { key: 'twitter', value: '', dirty: false },
      { key: 'payDisclosure', value: '', dirty: false },
      { key: 'storeCategories', value: {}, dirty: false },
    ]);
    expect(out.name).toBe('FEPL League');
    const { name: _a, ...rest } = out;
    const { name: _b, ...expected } = LIVE;
    expect(rest).toEqual(expected);
    expect(Object.keys(out).sort()).toEqual(Object.keys(LIVE).sort());
    // Nested unknown object survives untouched.
    expect(out.extensions).toEqual({ fepl: { season: 2026, teams: [1, 2, 3] } });
    expect(out.leagueID).toBe('FEPL-2026');
    expect(out.tags).toEqual(['fantasy', 'epl']);
    // Untouched rich description is NOT degraded through the text round-trip.
    expect(out.description).toBe('<p>Hi <strong>there</strong></p>');
  });

  it('an untouched empty field never deletes the live value; a dirty empty field is an explicit clear', () => {
    const untouched = mergeProjectMetadataEdit(LIVE, [{ key: 'payDisclosure', value: '', dirty: false }]);
    expect(untouched.payDisclosure).toBe('Entry fees are final.');

    const cleared = mergeProjectMetadataEdit(LIVE, [{ key: 'payDisclosure', value: '', dirty: true }]);
    expect('payDisclosure' in cleared).toBe(false);

    const set = mergeProjectMetadataEdit(LIVE, [{ key: 'payDisclosure', value: 'No refunds.', dirty: true }]);
    expect(set.payDisclosure).toBe('No refunds.');
  });

  it('a dirty empty object clears the key; a dirty populated object replaces it', () => {
    const withCats = { ...LIVE, storeCategories: { 1: 'Kits' } };
    const cleared = mergeProjectMetadataEdit(withCats, [{ key: 'storeCategories', value: {}, dirty: true }]);
    expect('storeCategories' in cleared).toBe(false);
    const replaced = mergeProjectMetadataEdit(withCats, [{ key: 'storeCategories', value: { 1: 'Kits', 2: 'Balls' }, dirty: true }]);
    expect(replaced.storeCategories).toEqual({ 1: 'Kits', 2: 'Balls' });
  });

  it('starts from an empty object when the project has no metadata yet', () => {
    const out = mergeProjectMetadataEdit(null, [{ key: 'name', value: 'Fresh', dirty: true }]);
    expect(out).toEqual({ name: 'Fresh' });
  });
});

describe('projectCustomPropertiesText — the Advanced textarea prefill', () => {
  it('pretty-prints exactly the unmanaged keys, and round-trips byte-for-key through parse+merge', () => {
    const text = projectCustomPropertiesText(LIVE);
    // Prefill contains only unmanaged keys, pretty-printed.
    expect(JSON.parse(text)).toEqual({
      leagueID: 'FEPL-2026',
      tags: ['fantasy', 'epl'],
      extensions: { fepl: { season: 2026, teams: [1, 2, 3] } },
      version: 6,
    });
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    // Saving the untouched prefill reproduces the live metadata byte-for-key.
    const parsed = parseProjectCustomProperties(text);
    expect(parsed.error).toBeUndefined();
    const out = mergeProjectMetadataEdit(LIVE, [], { value: parsed.value, dirty: true });
    expect(out).toEqual(LIVE);
    expect(JSON.stringify(out.extensions)).toBe(JSON.stringify(LIVE.extensions));
  });

  it('is blank when the live metadata has no unmanaged keys (and for null)', () => {
    expect(projectCustomPropertiesText({ name: 'x', payDisclosure: 'p' })).toBe('');
    expect(projectCustomPropertiesText(null)).toBe('');
  });
});

describe('parseProjectCustomProperties — invalid JSON blocks the save', () => {
  it('accepts a plain object and reports managed-key collisions as stripped', () => {
    const ok = parseProjectCustomProperties('{ "leagueID": "X", "a": [1] }');
    expect(ok.error).toBeUndefined();
    expect(ok.value).toEqual({ leagueID: 'X', a: [1] });
    expect(ok.stripped).toEqual([]);

    const collide = parseProjectCustomProperties('{ "name": "sneaky", "leagueID": "X" }');
    expect(collide.error).toBeUndefined();
    expect(collide.stripped).toEqual(['name']);
  });

  it('treats blank text as an empty object (clear-all when dirty)', () => {
    expect(parseProjectCustomProperties('').value).toEqual({});
    expect(parseProjectCustomProperties('  \n ').value).toEqual({});
  });

  it('rejects malformed JSON and non-object JSON', () => {
    expect(parseProjectCustomProperties('{ leagueID: X }').error).toBeTruthy();
    expect(parseProjectCustomProperties('{"a": 1,}').error).toBeTruthy();
    for (const bad of ['[1,2]', '"str"', '42', 'null', 'true']) {
      expect(parseProjectCustomProperties(bad).error, bad).toBeTruthy();
    }
  });
});

describe('mergeProjectMetadataEdit — customProperties replaces the unmanaged-key set', () => {
  it('supports editing, adding, and deleting custom keys', () => {
    const out = mergeProjectMetadataEdit(LIVE, [], {
      dirty: true,
      // leagueID edited, newKey added; tags/extensions/version omitted → deleted.
      value: { leagueID: 'FEPL-2027', newKey: { nested: true } },
    });
    expect(out.leagueID).toBe('FEPL-2027');
    expect(out.newKey).toEqual({ nested: true });
    expect('tags' in out).toBe(false);
    expect('extensions' in out).toBe(false);
    expect('version' in out).toBe(false);
    // Managed fields untouched.
    expect(out.name).toBe('FEPL');
    expect(out.payDisclosure).toBe('Entry fees are final.');
  });

  it('managed form fields win on collision — managed keys inside the custom object are stripped', () => {
    const out = mergeProjectMetadataEdit(LIVE, [{ key: 'name', value: 'Formal', dirty: true }], {
      dirty: true,
      value: { name: 'Sneaky', payDisclosure: 'Sneaky too', leagueID: 'FEPL-2026' },
    });
    expect(out.name).toBe('Formal'); // dirty form edit wins
    expect(out.payDisclosure).toBe('Entry fees are final.'); // untouched form field keeps live value
    expect(out.leagueID).toBe('FEPL-2026');
  });

  it('untouched blank vs cleared prefill: not-dirty keeps every custom key; dirty-empty deletes them all', () => {
    const untouched = mergeProjectMetadataEdit(LIVE, [], { value: {}, dirty: false });
    expect(untouched).toEqual(LIVE);
    const alsoUntouched = mergeProjectMetadataEdit(LIVE, []);
    expect(alsoUntouched).toEqual(LIVE);

    const cleared = mergeProjectMetadataEdit(LIVE, [], { value: parseProjectCustomProperties('').value, dirty: true });
    expect(unmanagedProjectMetadataKeys(cleared)).toEqual([]);
    expect(cleared.name).toBe('FEPL');
    expect(cleared.payDisclosure).toBe('Entry fees are final.');
  });

  it('the add-store-categories writer (no customProperties arg) still round-trips custom keys untouched', () => {
    // addStoreCategories merges only storeCategories over the live JSON — the shared merge path must
    // never drop custom keys when no customProperties input is given.
    const out = mergeProjectMetadataEdit(LIVE, [{ key: 'storeCategories', value: { 1: 'Kits' }, dirty: true }]);
    expect(out.storeCategories).toEqual({ 1: 'Kits' });
    expect(out.leagueID).toBe('FEPL-2026');
    expect(out.tags).toEqual(['fantasy', 'epl']);
    expect(out.extensions).toEqual({ fepl: { season: 2026, teams: [1, 2, 3] } });
    expect(out.version).toBe(6);
  });
});

describe('unmanagedProjectMetadataKeys — the Advanced textarea key set', () => {
  it('lists only keys the form does not edit, sorted', () => {
    expect(unmanagedProjectMetadataKeys(LIVE)).toEqual(['extensions', 'leagueID', 'tags', 'version']);
  });

  it('is empty for null and for purely form-managed metadata', () => {
    expect(unmanagedProjectMetadataKeys(null)).toEqual([]);
    expect(unmanagedProjectMetadataKeys({
      name: 'x', projectTagline: 'y', description: 'z', infoUri: 'u', logoUri: 'l',
      twitter: 't', discord: 'd', telegram: 'g', payDisclosure: 'p', storeCategories: {},
    })).toEqual([]);
  });
});

describe('edit-project modal wiring (source contract)', () => {
  it('the submit path merges over the live JSON via mergeProjectMetadataEdit', () => {
    expect(discoverSrc).toMatch(/mergeProjectMetadataEdit\(meta, /);
  });

  it('fails closed when the live projectUri JSON cannot be loaded (both setUriOf writers)', () => {
    expect(discoverSrc).toMatch(/Could not load the current project metadata/);
    // Definition + the two setUriOf writers (edit-project modal, add-store-categories) routing through it.
    const uses = discoverSrc.match(/loadLiveProjectMetadata\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('has a Payment notice editor writing the same payDisclosure key the create flow writes', () => {
    expect(discoverSrc).toMatch(/Payment notice/);
    expect(discoverSrc).toMatch(/key: 'payDisclosure'/);
    expect(createSrc).toMatch(/m\.payDisclosure = d\.payDisclosure/);
  });

  it('renders the Advanced custom-properties expandable (collapsed <details>, app idiom) with the JSON textarea', () => {
    expect(discoverSrc).toMatch(/Advanced — custom properties \(JSON\)/);
    // Matches the app's existing expandable idiom (details.extras-more with a ▸/▾ summary).
    const advanced = discoverSrc.slice(discoverSrc.indexOf('Advanced — custom properties (JSON)') - 400);
    expect(advanced).toMatch(/extras-more/);
    expect(advanced).toMatch(/summary/);
    // Prefill is the pretty-printed unmanaged-key JSON.
    expect(discoverSrc).toMatch(/projectCustomPropertiesText\(/);
    expect(discoverSrc).toMatch(/unmanagedProjectMetadataKeys\(/);
  });

  it('the modal fails closed: the textarea loads from loadLiveProjectMetadata and the save is blocked before it resolves', () => {
    // The modal's own prefetch routes through the fail-closed loader (in addition to the two writers).
    const uses = discoverSrc.match(/loadLiveProjectMetadata\(/g) || [];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    expect(discoverSrc).toMatch(/Still loading the current project metadata/);
    expect(discoverSrc).toMatch(/Loading current metadata/);
  });

  it('the save path parses the textarea via parseProjectCustomProperties and feeds mergeProjectMetadataEdit', () => {
    expect(discoverSrc).toMatch(/parseProjectCustomProperties\(/);
    expect(discoverSrc).toMatch(/mergeProjectMetadataEdit\(meta, \[[\s\S]{0,900}\], form\.customProperties\)/);
  });

  it('the add-store-categories writer never touches custom properties', () => {
    const fn = discoverSrc.slice(discoverSrc.indexOf('async function addStoreCategories'), discoverSrc.indexOf('function renderTierCard'));
    expect(fn).toMatch(/loadLiveProjectMetadata\(/);
    expect(fn).not.toMatch(/customProperties/);
  });
});
