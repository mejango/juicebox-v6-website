import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(process.cwd(), 'src/discover.js'), 'utf8');

describe('LP transaction receipt safety', () => {
  it('rejects a mined revert before returning the LP transaction hash', () => {
    const start = source.indexOf('async function lpSendTx');
    const end = source.indexOf('\nvar lpPositionViewAbi', start);
    const helper = source.slice(start, end);
    expect(helper).toContain("receipt.status !== 'success'");
    expect(helper.indexOf("receipt.status !== 'success'")).toBeLessThan(helper.lastIndexOf('return hash'));
  });
});
