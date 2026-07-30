// Widget hardening for the burn/mint components:
// - the burn balance shown is the REAL signer's (burns spend from the connected wallet even while
//   View-as impersonates another account), with an explicit note when View-as is active;
// - burn refuses zero and over-balance token counts before any wallet round-trip;
// - mint refuses a zero token count.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseEther } from 'viem';

const REAL = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

const h = vi.hoisted(() => ({
  executeRead: undefined,
  executeTransaction: undefined,
  viewAs: null,
}));

vi.mock('../src/wallet.js', () => ({
  getAccount: vi.fn(() => '0x1111111111111111111111111111111111111111'),
  getWalletClient: vi.fn(() => null),
  createPublicClientForChain: vi.fn(() => null),
  connect: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
  onWalletChange: vi.fn(),
  switchChain: vi.fn(),
  eagerConnect: vi.fn(),
  getProviders: vi.fn(() => []),
  refreshProviders: vi.fn(),
  isSafeConnected: vi.fn(() => false),
  proposeSafeTransactions: vi.fn(),
  waitForSafeInitialization: vi.fn(() => Promise.resolve()),
  initSafeApp: vi.fn(() => Promise.resolve(null)),
  getSafeInfo: vi.fn(() => null),
  dispatchWalletChangeListeners: vi.fn(),
}));

vi.mock('../src/view-as.js', () => ({
  getViewAs: vi.fn(() => h.viewAs),
  setViewAs: vi.fn(),
  clearViewAs: vi.fn(),
  onViewAsChange: vi.fn(),
  VIEW_AS_TX_ERROR: 'View-as is active — transactions are disabled.',
}));

vi.mock('../src/component-base.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    executeRead: (...args) => h.executeRead(...args),
    executeTransaction: (...args) => h.executeTransaction(...args),
    discoverChains: (pid, cb) => cb([1]),
  };
});

import { renderBurnComponent } from '../src/burn-component.js';
import { renderMintComponent } from '../src/mint-component.js';

function setAmount(root, placeholder, value) {
  const input = root.querySelector('input[placeholder="' + placeholder + '"]');
  expect(input).toBeTruthy();
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function transactButton(root) {
  return [...root.querySelectorAll('button.btn-transact')].pop();
}

async function flush() {
  await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  h.executeRead = vi.fn((request) => Promise.resolve(
    request.functionName === 'controllerOf'
      ? '0x3333333333333333333333333333333333333333'
      : parseEther('5')
  ));
  h.executeTransaction = vi.fn();
  h.viewAs = null;
  document.body.innerHTML = '';
});

afterEach(() => {
  window.location.hash = '';
});

describe('burn component', () => {
  async function mountBurn() {
    window.location.hash = '#burn?projectId=5&chain=1';
    const root = renderBurnComponent();
    document.body.appendChild(root);
    await flush();
    return root;
  }

  it('loads and labels the REAL signer balance even while View-as is active', async () => {
    h.viewAs = OTHER;
    const root = await mountBurn();
    expect(h.executeRead).toHaveBeenCalled();
    expect(h.executeRead.mock.calls[0][0].args[0]).toBe(REAL);
    expect(root.textContent).toContain('5');
    expect(root.textContent).toMatch(/connected wallet/i);
  });

  it('shows no View-as note when nobody is impersonated', async () => {
    const root = await mountBurn();
    expect(h.executeRead.mock.calls[0][0].args[0]).toBe(REAL);
    expect(root.textContent).not.toMatch(/View as/i);
  });

  it('refuses a zero token count before reaching the wallet', async () => {
    const root = await mountBurn();
    setAmount(root, '100', '0');
    transactButton(root).click();
    expect(h.executeTransaction).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/above zero/i);
  });

  it('refuses a token count above the signer balance before reaching the wallet', async () => {
    const root = await mountBurn();
    setAmount(root, '100', '6');
    transactButton(root).click();
    expect(h.executeTransaction).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/more than/i);
  });

  it('still burns a valid in-balance count', async () => {
    const root = await mountBurn();
    setAmount(root, '100', '5');
    transactButton(root).click();
    await vi.waitFor(() => expect(h.executeTransaction).toHaveBeenCalledTimes(1));
    const request = h.executeTransaction.mock.calls[0][0];
    expect(request.args[2]).toBe(parseEther('5'));
    expect(request.reverify).toBeTypeOf('function');
    const readsBeforeReverify = h.executeRead.mock.calls.length;
    await expect(request.reverify()).resolves.toBeUndefined();
    expect(h.executeRead.mock.calls.length).toBe(readsBeforeReverify + 2);
  });
});

describe('mint component', () => {
  async function mountMint() {
    window.location.hash = '#mint?projectId=5&chain=1';
    const root = renderMintComponent();
    document.body.appendChild(root);
    await flush();
    return root;
  }

  it('refuses a zero token count before reaching the wallet', async () => {
    const root = await mountMint();
    setAmount(root, '1000', '0');
    transactButton(root).click();
    expect(h.executeTransaction).not.toHaveBeenCalled();
    expect(root.textContent).toMatch(/above zero/i);
  });

  it('still mints a positive count', async () => {
    const root = await mountMint();
    setAmount(root, '1000', '3');
    transactButton(root).click();
    expect(h.executeTransaction).toHaveBeenCalledTimes(1);
    expect(h.executeTransaction.mock.calls[0][0].args[1]).toBe(parseEther('3'));
  });
});
