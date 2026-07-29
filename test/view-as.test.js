// "View as" (impersonation) store: persistence, listeners, and the read/write seam —
// getEffectiveAccount() resolves to the viewed address while transaction funnels refuse.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'js-view-as-v1';
const ADDR = '0x823b92d6A4b2AED4b15675c7917c9f922ea8ADAd';
const OTHER = '0x1111111111111111111111111111111111111111';

describe('view-as store', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function fresh() {
    return await import('../src/view-as.js');
  }

  it('defaults to null and returns what was set', async () => {
    const store = await fresh();
    expect(store.getViewAs()).toBeNull();
    store.setViewAs(ADDR);
    expect(store.getViewAs()).toBe(ADDR);
  });

  it('persists to localStorage under js-view-as-v1 and restores on a fresh import', async () => {
    const store = await fresh();
    store.setViewAs(ADDR);
    expect(localStorage.getItem(KEY)).toBe(ADDR);
    vi.resetModules();
    const restored = await import('../src/view-as.js');
    expect(restored.getViewAs()).toBe(ADDR);
  });

  it('clearViewAs removes the persisted value', async () => {
    const store = await fresh();
    store.setViewAs(ADDR);
    store.clearViewAs();
    expect(store.getViewAs()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('treats empty/whitespace input as clearing', async () => {
    const store = await fresh();
    store.setViewAs(ADDR);
    store.setViewAs('   ');
    expect(store.getViewAs()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('notifies listeners on change, supports unsubscribe, and isolates listener failures', async () => {
    const store = await fresh();
    const seen = [];
    const boom = vi.fn(() => { throw new Error('listener boom'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.onViewAsChange(boom);
    const unsubscribe = store.onViewAsChange((value) => seen.push(value));
    store.setViewAs(ADDR);
    store.setViewAs(ADDR); // no-op: same value must not notify again
    store.setViewAs(OTHER);
    unsubscribe();
    store.clearViewAs();
    expect(seen).toEqual([ADDR, OTHER]);
    expect(boom).toHaveBeenCalledTimes(3); // failing listener never blocks the others
    errorSpy.mockRestore();
  });

  it('exports the exact transact-refusal message', async () => {
    const store = await fresh();
    expect(store.VIEW_AS_TX_ERROR).toBe("You're viewing the site as another account — exit View as to transact.");
  });
});

describe('view-as read/write seam (component-base)', () => {
  afterEach(async () => {
    const { clearViewAs } = await import('../src/view-as.js');
    clearViewAs();
    document.querySelectorAll('dialog.modal-dialog').forEach((node) => node.remove());
  });

  it('getEffectiveAccount prefers the viewed address over the connected wallet', async () => {
    const base = await import('../src/component-base.js');
    base.clearViewAs();
    expect(base.getEffectiveAccount()).toBe(base.getAccount()); // no impersonation → connected (null here)
    base.setViewAs(ADDR);
    expect(base.getEffectiveAccount()).toBe(ADDR);
    expect(base.getAccount()).not.toBe(ADDR); // the REAL account is untouched
  });

  it('executeTransaction refuses while view-as is active', async () => {
    const base = await import('../src/component-base.js');
    base.setViewAs(ADDR);
    const onError = vi.fn();
    base.executeTransaction({ chainId: 1, address: OTHER, abi: [], functionName: 'noop', args: [], onError });
    expect(onError).toHaveBeenCalledWith(base.VIEW_AS_TX_ERROR);
  });

  it('confirmTransactionModal shows the refusal notice and resolves cancelled', async () => {
    const base = await import('../src/component-base.js');
    base.setViewAs(ADDR);
    const resultPromise = base.confirmTransactionModal({ action: 'Pay', chainId: 1 }, { keepOpenForProgress: true });
    const dialog = document.querySelector('dialog.modal-dialog');
    expect(dialog.textContent).toContain(base.VIEW_AS_TX_ERROR);
    expect(dialog.querySelector('.create-btn.primary')).toBeNull(); // nothing to confirm
    dialog.querySelector('.create-btn.ghost').click();
    const result = await resultPromise;
    expect(result).toEqual({ ok: false });
    expect(document.body.contains(dialog)).toBe(false);
  });
});
