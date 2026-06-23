// attachPagination drives the owners + Market table footers: one page of `pageSize` rows at a time, with a
// First / Prev / "page / total" / Next / Last nav that hides itself for a single page.
import { describe, it, expect, beforeAll } from 'vitest';
import { attachPagination } from '../src/discover.js';

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the nav calls it on page change.
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = function () {};
});

function row(item, idx) { const d = document.createElement('div'); d.className = 'row'; d.textContent = item + ':' + idx; return d; }
function nthBtn(nav, re) { return [].slice.call(nav.querySelectorAll('.list-page-btn')).find((b) => re.test(b.textContent)); }
function indicator(nav) { const i = nav.querySelector('.list-page-indicator'); return i ? i.textContent : null; }

describe('attachPagination', () => {
  it('renders one page (pageSize rows) and a nav with the right indicator + buttons', () => {
    const c = document.createElement('div');
    const items = Array.from({ length: 75 }, (_, i) => i);
    const nav = attachPagination(c, items, 30, row);
    expect(c.querySelectorAll('.row').length).toBe(30);
    expect(indicator(nav)).toBe('1 / 3'); // ceil(75/30) = 3
    expect(nav.style.display).not.toBe('none');
    ['First', 'Prev', 'Next', 'Last'].forEach((l) => expect(nthBtn(nav, new RegExp(l))).toBeTruthy());
    // buildRow receives the GLOBAL index (for the first page, item === idx)
    expect(c.querySelector('.row').textContent).toBe('0:0');
  });

  it('Next / Last advance the page and pass the global index to buildRow', () => {
    const c = document.createElement('div');
    const nav = attachPagination(c, Array.from({ length: 75 }, (_, i) => i), 30, row);
    nthBtn(nav, /Next/).click();
    expect(indicator(nav)).toBe('2 / 3');
    expect(c.querySelector('.row').textContent).toBe('30:30'); // page 2 starts at global index 30
    nthBtn(nav, /Last/).click();
    expect(indicator(nav)).toBe('3 / 3');
    expect(c.querySelectorAll('.row').length).toBe(15); // last page: 75 - 60
    expect(c.querySelector('.row').textContent).toBe('60:60');
  });

  it('First / Prev clamp at page 0', () => {
    const c = document.createElement('div');
    const nav = attachPagination(c, Array.from({ length: 75 }, (_, i) => i), 30, row);
    nthBtn(nav, /Last/).click();
    nthBtn(nav, /First/).click();
    expect(indicator(nav)).toBe('1 / 3');
    nthBtn(nav, /Prev/).click(); // already at first
    expect(indicator(nav)).toBe('1 / 3');
  });

  it('hides the nav when there is only one page', () => {
    const c = document.createElement('div');
    const nav = attachPagination(c, [1, 2, 3], 30, row);
    expect(c.querySelectorAll('.row').length).toBe(3);
    expect(nav.style.display).toBe('none');
  });
});
