import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/discover.js', 'utf8');
const styles = readFileSync('src/style.css', 'utf8');

describe('project detail tab overflow', () => {
  it('reveals Extras and Owner/Operator inline from a right-aligned toggle', () => {
    expect(source).toContain("var overflowTabNames = ['Extras', ownerTabName]")
    expect(source).toContain("setAttribute('aria-label', 'More project sections')")
    expect(source).toContain("item.setAttribute('role', 'tab')")
    expect(source).toContain("overflowButton.textContent = expanded ? '⋯' : '⋮'")
    expect(source).toContain("overflowButton.dataset.overflowOrientation = expanded ? 'horizontal' : 'vertical'")
    expect(styles).toContain('.detail-tab-overflow {')
    expect(styles).toContain('align-items: flex-start;')
    expect(styles).toContain('align-items: center; justify-content: center;')
    expect(styles).toContain('.detail-tab-overflow-item[hidden] { display: none; }')
  })

  it('locks every horizontally scrollable tab row to its horizontal axis', () => {
    expect(styles).toContain('touch-action: pan-x;')
    expect(styles).toContain('overflow-y: hidden;')
    expect(styles).toContain('overscroll-behavior-x: contain;')
  })

  it('keeps deep-linked overflow tabs in the lazy builder set', () => {
    expect(source).toContain('var visibleTabs = tabs.filter')
    expect(source).toContain('for (var t = 0; t < tabs.length; t++)')
    expect(source).toContain('selectProjectTab(tabName)')
  })
})
