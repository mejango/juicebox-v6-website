import { afterEach, describe, expect, it } from 'vitest';
import { confirmTransactionModal } from '../src/component-base.js';

afterEach(() => {
  document.querySelectorAll('dialog.modal-dialog').forEach((node) => node.remove());
});

describe('transaction confirmation recovery', () => {
  it('can be dismissed after a simulation or send error', async () => {
    const resultPromise = confirmTransactionModal({
      action: 'Queue ruleset',
      chain: 'Base Sepolia',
      chainId: 84532,
      contract: 'JBController',
      address: '0x1111111111111111111111111111111111111111',
      function: 'queueRulesetsOf',
      args: { projectId: 9 },
      value: 0n,
    }, { keepOpenForProgress: true });

    const dialog = document.querySelector('dialog.modal-dialog');
    const confirm = dialog.querySelector('.create-modal-foot .create-btn.primary');
    const cancel = dialog.querySelector('.create-modal-foot .create-btn.ghost');
    confirm.click();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(cancel.disabled).toBe(true);
    result.showStatus('Deployment failed', 'error');
    expect(cancel.disabled).toBe(false);
    expect(cancel.textContent).toBe('Close');

    dialog.querySelector('.modal-close').click();
    expect(document.body.contains(dialog)).toBe(false);
  });
});
