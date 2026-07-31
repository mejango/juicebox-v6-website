// Keep economic participation separate from protocol authority: token holders
// live under Accounts within the revnet Owners tab; Owner and Operator are authority roles.
import { beforeEach, describe, it, expect } from 'vitest';
import { OWNERS_STAT_LABEL, OWNERS_SUBTABS_CUSTOM, OWNERS_SUBTABS_DEFAULT, projectParticipantStatLabel } from '../src/discover.js';
import { renderLearnTab } from '../src/learn-build.js';

describe('project-page authority terminology', () => {
  it('names the holders subtab Accounts for revnets and custom projects', () => {
    expect(OWNERS_SUBTABS_DEFAULT[0]).toBe('Accounts');
    expect(OWNERS_SUBTABS_CUSTOM[0]).toBe('Accounts');
    expect(OWNERS_SUBTABS_DEFAULT).not.toContain('Owners');
    expect(OWNERS_SUBTABS_CUSTOM).not.toContain('Owners');
    expect(OWNERS_SUBTABS_CUSTOM).toContain('Reserved');
  });

  it('calls revnet token holders owners without conflating custom-project authority', () => {
    expect(OWNERS_STAT_LABEL).toBe('Token holders');
    expect(projectParticipantStatLabel(true)).toBe('Owners');
    expect(projectParticipantStatLabel(false)).toBe('Token holders');
  });
});

describe('Learn tab terminology', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><section id="tab-learn"></section></main>';
  });

  it('says token holders, not token owners', () => {
    renderLearnTab();
    const learn = document.getElementById('tab-learn');
    expect(learn.textContent).toMatch(/token holders/i);
    expect(learn.textContent).not.toMatch(/token owners/i);
  });
});
