import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/discover.js', 'utf8');

describe('Extras secondary actions', () => {
  it('uses the shared secondary button for export and payer creation', () => {
    expect(source).toContain("var button = el('a', 'operator-cta'); button.href = '#'; button.textContent = 'Export .jb'");
    expect(source).toContain("var openPayerForm = el('button', 'operator-cta')");
    expect(source).not.toContain("el('a', 'operator-cta operator-edit-submit'); button.href = '#'; button.textContent = 'Export .jb'");
  });
});
