// DATA tab CSV export: a [DOWNLOAD CSV] button on query results serializing the current rows
// client-side (blob download) — column labels as the header, cells escaped RFC-4180 style.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataRowsToCsv, renderDataTab } from '../src/data-tab.js';
import { setBendystrawNetwork } from '../src/bendystraw-client.js';

describe('dataRowsToCsv', () => {


  it('neutralizes formula-injection payloads in attacker-controlled strings', () => {
    // Project names and memos come from chain. A cell starting with = + - or @ is executed as
    // a formula by Excel/Numbers/Sheets when the export is opened.
    const columns = [{ key: 'name', label: 'Name' }];
    const csv = dataRowsToCsv(columns, [
      { name: '=HYPERLINK("http://evil","click")' },
      { name: '+1234' },
      { name: '-cmd' },
      { name: '@SUM(A1)' },
      { name: 'Normal Project' },
    ]);
    const rows = csv.split('\r\n').slice(1);
    expect(rows[0].startsWith('"\'=HYPERLINK')).toBe(true);
    expect(rows[1]).toBe("'+1234");
    expect(rows[2]).toBe("'-cmd");
    expect(rows[3]).toBe("'@SUM(A1)");
    // An ordinary value is untouched.
    expect(rows[4]).toBe('Normal Project');
  });
  const columns = [
    { label: 'Project', key: 'projectId' },
    { label: 'Name', key: 'name' },
    { label: 'Owner', key: 'owner' },
  ];

  it('serializes rows in column order with a label header', () => {
    const csv = dataRowsToCsv(columns, [
      { projectId: 1, name: 'NANA', owner: '0xabc' },
      { projectId: 2, name: 'REV', owner: '0xdef' },
    ]);
    expect(csv.split('\r\n')).toEqual([
      'Project,Name,Owner',
      '1,NANA,0xabc',
      '2,REV,0xdef',
    ]);
  });

  it('escapes commas, quotes, and newlines; blanks null/undefined cells', () => {
    const csv = dataRowsToCsv(columns, [
      { projectId: 3, name: 'a,b "c"\nd', owner: null },
    ]);
    expect(csv.split('\r\n')[1]).toBe('3,"a,b ""c""\nd",');
  });

  it('serializes nested objects as JSON rather than [object Object]', () => {
    const csv = dataRowsToCsv([{ label: 'X', key: 'x' }], [{ x: { a: 1 } }]);
    expect(csv).toContain('"{""a"":1}"');
  });
});

describe('DATA tab result CSV button', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="tab-data"></div>';
    setBendystrawNetwork('testnet');
  });
  afterEach(() => {
    setBendystrawNetwork('mainnet');
    document.body.innerHTML = '';
  });

  it('appears after a successful list query and downloads the current rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { projects: { totalCount: 1, items: [{ projectId: 1, name: 'NANA' }] } } }),
    })));
    renderDataTab();
    const preview = Array.from(document.querySelectorAll('.data-row .fn-name-preview'))
      .find(node => node.textContent === 'List projects');
    preview.closest('.data-row').querySelector('.fn-summary').click();
    const row = preview.closest('.data-row');
    row.querySelector('.data-run-btn').click();
    await vi.waitFor(() => {
      expect(row.querySelector('.data-csv-btn')).not.toBeNull();
    });
    expect(row.querySelector('.data-csv-btn').textContent).toMatch(/csv/i);
  });
});
