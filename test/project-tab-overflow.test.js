import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/discover.js', 'utf8');
const styles = readFileSync('src/style.css', 'utf8');

describe('project detail tab overflow', () => {
  it('keeps Extras and Owner/Operator reachable through a right-aligned menu', () => {
    expect(source).toContain("var overflowTabNames = ['Extras', ownerTabName]")
    expect(source).toContain("setAttribute('aria-haspopup', 'menu')")
    expect(source).toContain("setAttribute('aria-label', 'More project sections')")
    expect(styles).toContain('.detail-tab-overflow { position: relative; flex: 0 0 auto; margin-left: auto; }')
  })

  it('keeps deep-linked overflow tabs in the lazy builder set', () => {
    expect(source).toContain('var visibleTabs = tabs.filter')
    expect(source).toContain('for (var t = 0; t < tabs.length; t++)')
    expect(source).toContain('selectProjectTab(tabName)')
  })
})
