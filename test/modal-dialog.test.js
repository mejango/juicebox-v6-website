// Every modal in the app is a native <dialog> opened with showModal(). These tests pin the shared
// contract: one dialog root per modal, no overlay div, no per-modal document keydown handler, Escape
// scoped to the top dialog, backdrop-click-to-close, and an accessible name taken from the title.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmTransactionModal, el, openDialog } from '../src/component-base.js';
import { openCreateFlow } from '../src/create-flow.js';
import { openModal } from '../src/discover.js';

function pressEscape() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
}

function clickOn(target) {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  document.querySelectorAll('dialog').forEach((node) => { if (node.open) node.close(); node.remove(); });
});

describe('native <dialog> modal root', () => {
  it('opens a real dialog in the top layer instead of an overlay div', () => {
    const modal = openDialog('Cash out');
    expect(modal.dialog.tagName).toBe('DIALOG');
    expect(modal.dialog.className).toBe('modal-dialog');
    expect(modal.dialog.open).toBe(true);
    expect(modal.dialog.parentNode).toBe(document.body);
    // The dimming layer is now ::backdrop — no overlay element is created anywhere.
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('names the dialog from its own visible title', () => {
    const modal = openDialog('Queue ruleset');
    const title = modal.dialog.querySelector('.modal-title');
    expect(title.textContent).toBe('Queue ruleset');
    expect(title.id).toBeTruthy();
    expect(modal.dialog.getAttribute('aria-labelledby')).toBe(title.id);
    // showModal() implies role="dialog" + aria-modal — the app must not hand-roll them.
    expect(modal.dialog.getAttribute('role')).toBeNull();
    expect(modal.dialog.getAttribute('aria-modal')).toBeNull();
  });

  it('gives every stacked dialog its own title id', () => {
    const first = openDialog('First');
    const second = openDialog('Second');
    expect(first.dialog.getAttribute('aria-labelledby'))
      .not.toBe(second.dialog.getAttribute('aria-labelledby'));
  });

  it('labels the close button for assistive tech', () => {
    const modal = openDialog('Edit project');
    expect(modal.closeButton.getAttribute('aria-label')).toBe('Close');
    expect(modal.closeButton.type).toBe('button');
    clickOn(modal.closeButton);
    expect(modal.dialog.open).toBe(false);
    expect(document.body.contains(modal.dialog)).toBe(false);
  });

  it('closes on a backdrop click but not on a click inside the panel', () => {
    const modal = openDialog('Move between chains');
    clickOn(modal.panel);
    expect(modal.dialog.open).toBe(true);
    clickOn(modal.dialog); // a backdrop click targets the <dialog> itself
    expect(modal.dialog.open).toBe(false);
  });

  it('closes once, idempotently, and detaches the dialog', () => {
    const onClose = vi.fn();
    const modal = openDialog('Claim credits', { onClose });
    modal.close();
    modal.close();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.contains(modal.dialog)).toBe(false);
  });

  it('refuses Escape, the close button and backdrop clicks while canClose() says no', () => {
    let sending = true;
    const modal = openDialog('Confirm add liquidity', { canClose: () => !sending });
    pressEscape();
    clickOn(modal.closeButton);
    clickOn(modal.dialog);
    expect(modal.dialog.open).toBe(true);
    sending = false;
    pressEscape();
    expect(modal.dialog.open).toBe(false);
  });
});

describe('Escape is scoped to the top dialog', () => {
  it('closes only the newest modal, then the one beneath it', () => {
    const first = openDialog('Get a loan');
    const second = openDialog('Confirm transaction');
    pressEscape();
    expect(second.dialog.open).toBe(false);
    expect(document.body.contains(second.dialog)).toBe(false);
    expect(first.dialog.open).toBe(true); // the stacked-Escape bug: this used to close too
    pressEscape();
    expect(first.dialog.open).toBe(false);
  });

  it('leaves no document keydown handler behind after a modal closes', () => {
    const modal = openDialog('Add operator');
    modal.close();
    const survivor = openDialog('Shop item #1');
    const cancelled = vi.fn();
    survivor.dialog.addEventListener('cancel', cancelled);
    pressEscape();
    expect(cancelled).toHaveBeenCalledTimes(1); // only the live dialog reacts
    expect(survivor.dialog.open).toBe(false);
  });
});

describe('openModal public contract', () => {
  it('keeps returning { close } and renders the caller content into the dialog', () => {
    const content = el('div', 'modal-body');
    content.textContent = 'body copy';
    const handle = openModal('Distribute payouts', content);
    const dialog = document.querySelector('dialog.modal-dialog');
    expect(typeof handle.close).toBe('function');
    expect(dialog.querySelector('.modal-title').textContent).toBe('Distribute payouts');
    expect(dialog.contains(content)).toBe(true);
    expect(dialog.querySelector('.comp-prompt-foot')).not.toBeNull(); // build-prompt link, as before
    handle.close();
    expect(document.querySelector('dialog.modal-dialog')).toBeNull();
  });

  it('omits the build-prompt link for transient confirmations', () => {
    openModal('Confirm transaction', el('div', 'pay-confirm'), { noPrompt: true });
    expect(document.querySelector('dialog.modal-dialog .comp-prompt-foot')).toBeNull();
  });

  it('still closes on the jb:close-modal event', () => {
    const content = el('div', 'modal-body');
    openModal('Redeem items', content);
    content.dispatchEvent(new CustomEvent('jb:close-modal'));
    expect(document.querySelector('dialog.modal-dialog')).toBeNull();
  });

  it('closes only the top modal when two are stacked', () => {
    openModal('Cash out', el('div', 'modal-body'));
    openModal('Confirm cash out', el('div', 'pay-confirm'), { noPrompt: true });
    expect(document.querySelectorAll('dialog.modal-dialog').length).toBe(2);
    pressEscape();
    const left = document.querySelectorAll('dialog.modal-dialog');
    expect(left.length).toBe(1);
    expect(left[0].querySelector('.modal-title').textContent).toBe('Cash out');
  });

  it('honours a caller-supplied canClose guard', () => {
    let busy = true;
    openModal('Confirm claim', el('div', 'pay-confirm'), { noPrompt: true, canClose: () => !busy });
    pressEscape();
    expect(document.querySelector('dialog.modal-dialog')).not.toBeNull();
    busy = false;
    pressEscape();
    expect(document.querySelector('dialog.modal-dialog')).toBeNull();
  });
});

describe('the create wizard shares the same top layer', () => {
  it('keeps the wizard open when Escape dismisses a modal opened above it', () => {
    const wizard = openCreateFlow();
    const overlay = document.querySelector('dialog.create-overlay');
    expect(overlay.open).toBe(true);
    openModal('Confirm transaction', el('div', 'pay-confirm'), { noPrompt: true });

    pressEscape();
    expect(document.querySelector('dialog.modal-dialog')).toBeNull();
    expect(overlay.open).toBe(true); // the wizard used to be torn down by the same keypress

    pressEscape();
    expect(document.body.contains(overlay)).toBe(false);
    wizard.close(); // idempotent
  });
});

describe('confirmTransactionModal on the dialog root', () => {
  it('refuses Escape while a reviewed transaction is in flight, then allows it after an error', async () => {
    const resultPromise = confirmTransactionModal({
      action: 'Queue ruleset', chain: 'Base Sepolia', chainId: 84532,
      contract: 'JBController', address: '0x1111111111111111111111111111111111111111',
      function: 'queueRulesetsOf', args: { projectId: 9 }, value: 0n,
    }, { keepOpenForProgress: true });
    const dialog = document.querySelector('dialog.modal-dialog');
    dialog.querySelector('.create-modal-foot .create-btn.primary').click();
    const result = await resultPromise;
    expect(result.ok).toBe(true);

    pressEscape();
    expect(dialog.open).toBe(true); // in flight — dismissal is refused

    result.showStatus('Send failed', 'error'); // terminal: the user may back out again
    pressEscape();
    expect(dialog.open).toBe(false);
    expect(document.body.contains(dialog)).toBe(false);
  });

  it('resolves cancelled when Escape dismisses the review', async () => {
    const resultPromise = confirmTransactionModal({ action: 'Pay', chainId: 1 }, { keepOpenForProgress: true });
    pressEscape();
    await expect(resultPromise).resolves.toEqual({ ok: false });
  });
});
