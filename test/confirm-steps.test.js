import { afterEach, describe, expect, it } from 'vitest';
import { confirmStepsFor, confirmTransactionModal, humanizeFunctionName } from '../src/component-base.js';

afterEach(() => {
  document.querySelectorAll('dialog.modal-dialog').forEach((node) => node.remove());
});

const call = {
  chain: 'Base Sepolia',
  chainId: 84532,
  contract: 'JBController',
  address: '0x1111111111111111111111111111111111111111',
  function: 'sendReservedTokensToSplitsOf',
  args: { projectId: 9 },
  value: 0n,
};

function stepLabels(dialog) {
  return Array.from(dialog.querySelectorAll('.pay-confirm-sequence-step')).map((li) => li.textContent);
}
function activeStep(dialog) {
  return Array.from(dialog.querySelectorAll('.pay-confirm-sequence-step')).findIndex((li) => li.classList.contains('active'));
}

describe('stepped confirm dialog', () => {
  it('derives a one-item wallet-step list from the payload', () => {
    expect(humanizeFunctionName('sendReservedTokensToSplitsOf')).toBe('Send reserved tokens to splits');
    expect(confirmStepsFor(call)).toEqual(['Send reserved tokens to splits']);
    expect(confirmStepsFor(Object.assign({ summary: { action: 'Distribute reserved tokens', rows: [] } }, call))).toEqual(['Distribute reserved tokens']);
    expect(confirmStepsFor(Object.assign({ erc20Approval: { token: '0x2', spender: '0x3', amount: 1n }, action: 'Pay' }, call)))
      .toEqual(['Approve token access if needed', 'Pay']);
    expect(confirmStepsFor({ chains: [{ chain: 'Base' }, { chain: 'Optimism' }] })).toEqual(['Sign for Base', 'Sign for Optimism', 'Pay the relay fee once']);
  });

  it('renders the step list first, the friendly rows, and advances through showNext in one dialog', async () => {
    const first = confirmTransactionModal(Object.assign({
      summary: { action: 'Approve the loan contract', rows: [['Allows', 'REVLoans to burn collateral']] },
    }, call), { keepOpenForProgress: true, steps: ['Approve the loan contract', 'Open the loan'], stepIndex: 0, confirmText: 'Approve' });
    const dialog = document.querySelector('dialog.modal-dialog');
    const content = dialog.querySelector('.pay-confirm');
    expect(content.firstChild.className).toBe('pay-confirm-sequence');
    expect(stepLabels(dialog)).toEqual(['1Approve the loan contract', '2Open the loan']);
    expect(activeStep(dialog)).toBe(0);
    expect(dialog.querySelector('.tx-decoded-argname').textContent).toBe('Allows: ');
    expect(dialog.querySelector('.tx-rawdata')).not.toBeNull();

    const confirm = dialog.querySelector('.create-modal-foot .create-btn.primary');
    expect(confirm.textContent).toBe('Approve');
    confirm.click();
    const session = await first;
    expect(session.ok).toBe(true);
    session.showStatus('Awaiting wallet confirmation…', 'pending');
    expect(activeStep(dialog)).toBe(0);

    const second = session.showNext(Object.assign({ summary: { action: 'Open the loan', rows: [['Collateral', '10 TOK']] } }, call), { confirmText: 'Open loan' });
    expect(document.querySelectorAll('dialog.modal-dialog').length).toBe(1);
    expect(activeStep(dialog)).toBe(1);
    expect(stepLabels(dialog)[0]).toBe('✓Approve the loan contract');
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toBe('Open loan');
    expect(dialog.querySelector('.tx-decoded-argname').textContent).toBe('Collateral: ');
    confirm.click();
    const next = await second;
    expect(next.ok).toBe(true);
    next.showStatus('Confirmed in block 1', 'success');
    expect(stepLabels(dialog)[1]).toBe('✓Open the loan');
  });

  it('marks the approval step while an ERC-20 approval runs, then the main step', async () => {
    const pending = confirmTransactionModal(Object.assign({ action: 'Pay', erc20Approval: { token: '0x2', spender: '0x3', amount: 1n } }, call), { keepOpenForProgress: true });
    const dialog = document.querySelector('dialog.modal-dialog');
    dialog.querySelector('.create-modal-foot .create-btn.primary').click();
    const session = await pending;
    session.showStatus('Approving token spend…', 'pending');
    expect(activeStep(dialog)).toBe(0);
    session.showStatus('Simulating the confirmed transaction…', 'pending');
    expect(activeStep(dialog)).toBe(1);
  });

  it('keeps the read-only details view free of wallet steps and still resolves on close', async () => {
    const pending = confirmTransactionModal(call, { steps: false, hideCancel: true, confirmText: 'Close' });
    const dialog = document.querySelector('dialog.modal-dialog');
    expect(dialog.querySelector('.pay-confirm-sequence')).toBeNull();
    dialog.querySelector('.create-modal-foot .create-btn.primary').click();
    expect(await pending).toBe(true);
    expect(document.body.contains(dialog)).toBe(false);
  });
});
