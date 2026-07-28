// One concept, one name: people who hold a project's tokens are "owners" on every project-page surface
// (the revnet tab convention). The DATA tab keeps schema-derived entity names (participants), but the
// Learn tab's narrative copy must use the same word as the product.
import { beforeEach, describe, it, expect } from 'vitest';
import { OWNERS_STAT_LABEL, OWNERS_SUBTABS_CUSTOM, OWNERS_SUBTABS_DEFAULT } from '../src/discover.js';
import { renderLearnTab } from '../src/learn-build.js';

describe('project-page owner terminology', () => {
  it('names the holders subtab "Owners" (not "Accounts") for revnets and custom projects', () => {
    expect(OWNERS_SUBTABS_DEFAULT[0]).toBe('Owners');
    expect(OWNERS_SUBTABS_CUSTOM[0]).toBe('Owners');
    expect(OWNERS_SUBTABS_DEFAULT).not.toContain('Accounts');
    expect(OWNERS_SUBTABS_CUSTOM).not.toContain('Accounts');
    expect(OWNERS_SUBTABS_CUSTOM).toContain('Reserved');
  });

  it('uses the same stat label on every project header', () => {
    expect(OWNERS_STAT_LABEL).toBe('Owners');
  });
});

describe('Learn tab terminology', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><section id="tab-learn"></section></main>';
  });

  it('says owners, never holders', () => {
    renderLearnTab();
    const learn = document.getElementById('tab-learn');
    expect(learn.textContent).toMatch(/token owners/i);
    expect(learn.textContent).not.toMatch(/\bholders?\b/i);
  });
});
