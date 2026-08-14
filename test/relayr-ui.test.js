import { beforeEach, describe, expect, it } from 'vitest';
import { relayrReceiptStateLabel, renderRelayrReceiptInto } from '../src/relayr-ui.js';

describe('Relayr paid-receipt UI', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="receipt"></div>';
  });

  it('normalizes terminal and pending states without treating unknown states as success', () => {
    expect(relayrReceiptStateLabel({ status: { state: 'Success' } })).toEqual({ text: 'Relayr reported success — verifying', kind: 'pending' });
    expect(relayrReceiptStateLabel({ status: { state: 'Completed' } }, true)).toEqual({ text: 'Confirmed', kind: 'ok' });
    expect(relayrReceiptStateLabel({ status: { state: 'Failed' } })).toEqual({ text: 'Failed', kind: 'err' });
    expect(relayrReceiptStateLabel({ status: { state: 'Included' } })).toEqual({ text: 'Included', kind: 'pending' });
    expect(relayrReceiptStateLabel(null)).toEqual({ text: 'Waiting for Relayr', kind: 'pending' });
  });

  it('renders exact progress, safe links, chain fallbacks, and attacker-controlled text as text', () => {
    const panel = document.querySelector('#receipt');
    const paymentHash = `0x${'11'.repeat(32)}`;
    const destinationHash = `0x${'22'.repeat(32)}`;
    const progress = renderRelayrReceiptInto(panel, {
      bundleUuid: '<img src=x onerror=alert(1)>',
      paymentHash,
      paymentChainId: 8453,
      expectedCount: 3,
      chains: [
        { id: 8453, name: 'Base' },
        { id: 10 },
      ],
      records: [
        { status: { state: 'Success', data: { hash: destinationHash } } },
        { status: { state: 'Failed' } },
      ],
    }, {
      chainNameOf: id => `Chain ${id}`,
      noteText: '<script>unsafe()</script>',
    });

    expect(progress).toEqual({ confirmed: 1, failed: 1, pending: 1, total: 3, allFailed: false });
    expect(panel.querySelector('.relayr-pending-count').textContent).toBe('1/3 reported complete');
    expect(panel.querySelectorAll('.relayr-pending-chain')).toHaveLength(3);
    expect([...panel.querySelectorAll('.relayr-pending-chain > span:first-child')].map(node => node.textContent))
      .toEqual(['Base', 'Chain 10', 'Chain 3']);
    expect(panel.querySelector('code').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.querySelector('.relayr-pending-note').textContent).toBe('<script>unsafe()</script>');
    for (const link of panel.querySelectorAll('a[target="_blank"]')) {
      expect(link.rel).toContain('noopener');
      expect(link.href).toMatch(/^https:\/\//);
    }
  });

  it('supports caller-specific state wording without creating a payment link on unknown chains', () => {
    const panel = document.querySelector('#receipt');
    renderRelayrReceiptInto(panel, {
      bundleUuid: 'bundle',
      paymentHash: `0x${'33'.repeat(32)}`,
      paymentChainId: 999999,
      records: [{ status: { state: 'Pending' } }],
      expectedCount: 1,
    }, {
      stateLabel: () => ({ text: 'Still executing', kind: 'pending' }),
    });

    expect(panel.querySelector('.relayr-pending-chain-state').textContent).toBe('Still executing');
    expect(panel.querySelector('.relayr-pending-meta a')).toBeNull();
  });
});
