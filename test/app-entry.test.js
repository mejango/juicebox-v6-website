import { describe, expect, it, vi } from 'vitest';

const entry = vi.hoisted(() => ({
  account: null,
  applyDiscoverRoute: vi.fn(),
  applySavedFont: vi.fn(),
  eagerConnect: vi.fn(),
  initSafeApp: vi.fn().mockResolvedValue(false),
  mountFontSelector: vi.fn(),
  renderAdminTab: vi.fn(),
  renderBuildTab: vi.fn(),
  renderDataTab: vi.fn(),
  renderDiscoverTab: vi.fn(),
  renderFunctionForm: vi.fn(() => {
    const form = document.createElement('div');
    form.className = 'function-form';
    return form;
  }),
  renderLearnTab: vi.fn(),
  renderWhyTab: vi.fn(),
  renderAccountView: vi.fn(),
}));

const readThing = {
  type: 'function',
  name: 'readThing',
  stateMutability: 'view',
  inputs: [{ name: 'id', type: 'uint256' }],
  outputs: [{ name: 'value', type: 'uint256' }],
};

vi.mock('../src/abi-registry.js', () => ({
  contracts: { JBExample: [readThing], JBDifferent: [readThing] },
  meta: {
    JBExample: {
      singleton: true,
      notice: 'Canonical example contract.',
      addresses: {
        1: '0x1111111111111111111111111111111111111111',
        10: '0x1111111111111111111111111111111111111111',
      },
    },
    JBDifferent: {
      singleton: true,
      addresses: {
        1: '0x2222222222222222222222222222222222222222',
        10: '0x3333333333333333333333333333333333333333',
      },
    },
  },
  natspec: { JBExample: { readThing: { notice: 'Reads canonical state.', params: { id: 'Identifier.' } } } },
  categories: { Core: ['JBExample', 'JBDifferent'], Empty: [] },
  chains: { 1: { name: 'Ethereum' }, 10: { name: 'Optimism' } },
  commonActions: [{
    title: 'Read actions',
    className: 'read-actions',
    entries: [{ contract: 'JBExample', function: 'readThing', label: 'READ THING', hint: 'from the contract' }],
  }],
  getFunctions: name => ['JBExample', 'JBDifferent'].includes(name) ? [readThing] : [],
  getAddress: () => '0x1111111111111111111111111111111111111111',
  getFunctionSource: () => ({ source: 'function readThing(uint256 id) external view returns (uint256);', startLine: 10, endLine: 12 }),
  getGithubUrl: (_name, fn) => fn ? 'https://github.com/example/contracts/blob/main/JBExample.sol#L10' : 'https://github.com/example/contracts',
}));

vi.mock('../src/form.js', () => ({ renderFunctionForm: entry.renderFunctionForm }));
vi.mock('../src/prompts.js', () => ({
  getAuditPrompt: () => 'audit the canonical V6 call',
  getComponentAuditPrompt: () => 'audit this component',
}));
vi.mock('../src/components.js', () => ({ renderStyleEditor: vi.fn() }));
vi.mock('../src/component-base.js', () => ({
  buildEmbedUrl: () => 'https://example.invalid/embed',
  getAccount: () => entry.account,
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  onWalletChange: vi.fn(),
  eagerConnect: entry.eagerConnect,
  truncAddr: value => value,
  getProviders: () => [],
  refreshProviders: vi.fn().mockResolvedValue([]),
  errMessage: error => error.message,
  initSafeApp: entry.initSafeApp,
}));
vi.mock('../src/learn-build.js', () => ({
  renderLearnTab: entry.renderLearnTab,
  renderBuildTab: entry.renderBuildTab,
  renderWhyTab: entry.renderWhyTab,
}));
vi.mock('../src/discover.js', () => ({
  renderDiscoverTab: entry.renderDiscoverTab,
  applyDiscoverRoute: entry.applyDiscoverRoute,
  renderAdminTab: entry.renderAdminTab,
  classifyAccountQuery: query => /^0x[0-9a-fA-F]{40}$/.test(String(query || '').trim())
    ? { kind: 'address', address: String(query).trim() }
    : { kind: 'text' },
  ensAddressOf: vi.fn().mockResolvedValue(null),
  identGradient: () => 'linear-gradient(135deg, #000, #fff)',
}));
vi.mock('../src/data-tab.js', () => ({ renderDataTab: entry.renderDataTab }));
vi.mock('../src/account-view.js', () => ({ renderAccountView: entry.renderAccountView }));
vi.mock('../src/create-flow.js', () => ({ reverseEns: vi.fn().mockResolvedValue(null) }));
vi.mock('../src/font-selector.js', () => ({
  mountFontSelector: entry.mountFontSelector,
  applySavedFont: entry.applySavedFont,
}));
vi.mock('../src/wallet-links.js', () => ({
  isMobileDevice: () => false,
  mobileWalletLinks: () => [],
  walletDappUrl: value => value,
}));

vi.mock('../src/pay-component.js', () => ({ renderPayComponent: vi.fn() }));
vi.mock('../src/cashout-component.js', () => ({ renderCashOutComponent: vi.fn() }));
vi.mock('../src/payouts-component.js', () => ({ renderPayoutsComponent: vi.fn() }));
vi.mock('../src/mint-component.js', () => ({ renderMintComponent: vi.fn() }));
vi.mock('../src/reserved-component.js', () => ({ renderReservedComponent: vi.fn() }));
vi.mock('../src/deploy-erc20-component.js', () => ({ renderDeployERC20Component: vi.fn() }));
vi.mock('../src/burn-component.js', () => ({ renderBurnComponent: vi.fn() }));
vi.mock('../src/launch-component.js', () => ({ renderLaunchComponent: vi.fn() }));
vi.mock('../src/queue-ruleset-component.js', () => ({ renderQueueRulesetComponent: vi.fn() }));
vi.mock('../src/permissions-component.js', () => ({ renderPermissionsComponent: vi.fn() }));

const tabs = [
  ['DISCOVER', 'discover'],
  ['ACTIONS', 'common'],
  ['LEARN', 'learn'],
  ['BUILD', 'build'],
  ['API', 'directory'],
  ['DATA', 'data'],
  ['ADMIN', 'admin'],
  ['WHY?', 'why'],
];

function shell() {
  return `
    <header id="header"><button id="connect-btn"></button></header>
    <nav id="tabs">${tabs.map(([label, tab]) => `<button class="tab" data-tab="${tab}">${label}</button>`).join('')}</nav>
    <a id="audit-prompt-link" href="#">audit</a>
    <main>${tabs.map(([, tab]) => `<section id="tab-${tab}" class="tab-content"></section>`).join('')}<section id="tab-account" class="tab-content"></section></main>
    <footer><span id="ipfs-cid-meta"></span></footer>`;
}

describe('production app entry point', () => {
  it('initializes every surface, routes hashes, and lazily builds contract forms', async () => {
    document.body.innerHTML = shell();
    history.replaceState(null, '', '/index.html#learn');
    Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    await import('../src/app.js');
    await vi.waitFor(() => expect(entry.eagerConnect).toHaveBeenCalledOnce());

    expect(entry.applySavedFont).toHaveBeenCalledOnce();
    expect(entry.mountFontSelector).toHaveBeenCalledOnce();
    expect(entry.renderDiscoverTab).toHaveBeenCalledOnce();
    expect(entry.renderDataTab).toHaveBeenCalledOnce();
    expect(entry.renderLearnTab).toHaveBeenCalledOnce();
    expect(entry.renderBuildTab).toHaveBeenCalledOnce();
    expect(entry.renderAdminTab).toHaveBeenCalledOnce();
    expect(entry.renderWhyTab).toHaveBeenCalledOnce();
    expect(document.querySelector('.tab[data-tab="learn"]').classList.contains('active')).toBe(true);
    expect(document.getElementById('tab-learn').classList.contains('active')).toBe(true);

    const common = document.getElementById('tab-common');
    expect(common.textContent).toMatch(/Work in progress/);
    expect(common.textContent).toMatch(/READ THING/);
    common.querySelector('.fn-summary').click();
    expect(entry.renderFunctionForm).toHaveBeenCalledWith(
      readThing,
      'JBExample',
      expect.any(Function),
      [readThing],
      expect.objectContaining({ notice: 'Reads canonical state.' }),
    );

    const contract = document.querySelector('.contract-section');
    expect(contract.textContent).toMatch(/Canonical example contract/);
    const address = contract.querySelector('.contract-address');
    expect(address.textContent).toBe('0x1111111111111111111111111111111111111111');
    expect(address.title).toMatch(/Ethereum, Optimism/);
    address.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
    ));
    const different = document.querySelectorAll('.contract-section')[1];
    expect(different.querySelector('.contract-addresses > summary').textContent).toBe('[2 chain addresses]');
    expect([...different.querySelectorAll('.contract-address-chain')].map(node => node.textContent))
      .toEqual(['Ethereum', 'Optimism']);
    expect([...different.querySelectorAll('.contract-address')].map(node => node.textContent)).toEqual([
      '0x2222222222222222222222222222222222222222',
      '0x3333333333333333333333333333333333333333',
    ]);
    contract.querySelector('.contract-summary').click();
    contract.querySelector('.fn-summary').click();
    expect(contract.textContent).toMatch(/readThing\(uint256 id\).*view.*returns \(uint256 value\)/s);
    const sourceSection = [...contract.querySelectorAll('.fn-section')]
      .find(section => section.querySelector('.fn-section-label')?.textContent === 'source');
    sourceSection.querySelector('.fn-section-header').click();
    expect(contract.querySelector('.fn-source-code').textContent).toMatch(/function readThing/);
    const useSection = [...contract.querySelectorAll('.fn-section')]
      .find(section => section.querySelector('.fn-section-label')?.textContent === 'use');
    useSection.querySelector('.fn-section-header').click();
    expect(useSection.querySelector('.function-form')).not.toBeNull();

    document.querySelector('.tab[data-tab="data"]').click();
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(location.hash).toBe('#data');
    expect(document.getElementById('tab-data').classList.contains('active')).toBe(true);

    location.hash = '#account/0x1111111111111111111111111111111111111111';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(entry.renderAccountView).toHaveBeenCalledWith('0x1111111111111111111111111111111111111111');
    expect(document.getElementById('tab-account').classList.contains('active')).toBe(true);

    document.getElementById('audit-prompt-link').click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('audit the canonical V6 call'));
    expect(document.getElementById('audit-prompt-link').textContent).toBe('COPIED TO CLIPBOARD');

    document.getElementById('connect-btn').click();
    await vi.waitFor(() => expect(document.querySelector('.wallet-menu-error')?.textContent).toMatch(/No wallet detected/));
    expect(entry.applyDiscoverRoute).not.toHaveBeenCalledWith(expect.any(String));

    // --- View as (impersonation) mode ---
    const viewed = '0x2222222222222222222222222222222222222222';
    expect(document.getElementById('viewas-link')).toBeNull();
    const viewAsItem = [...document.querySelectorAll('.wallet-menu-item')]
      .find(node => node.textContent === 'View as…');
    expect(viewAsItem).not.toBeNull();
    expect([...document.querySelectorAll('.wallet-menu-item')].at(-1)).toBe(viewAsItem);
    expect(document.querySelector('.wallet-menu-separator')).not.toBeNull();
    viewAsItem.click();
    const prompt = document.querySelector('.wallet-menu .viewas-prompt');
    expect(prompt).not.toBeNull();
    const promptInput = prompt.querySelector('.viewas-input');
    promptInput.value = 'not an account';
    prompt.querySelector('.viewas-go').click();
    expect(prompt.querySelector('.viewas-err').textContent).toMatch(/0x address or an ENS name/);
    promptInput.value = viewed;
    prompt.querySelector('.viewas-go').click();
    expect(document.querySelector('.wallet-menu')).toBeNull(); // prompt closed on activation
    expect(document.getElementById('connect-btn').textContent).toBe('Viewing as ' + viewed);
    expect(document.getElementById('viewas-banner')).toBeNull();

    // The viewed identity replaces the connected wallet; its menu can return to the real wallet.
    entry.account = '0x9999999999999999999999999999999999999999';
    document.getElementById('connect-btn').click();
    const menu = document.querySelector('.wallet-menu');
    const items = [...menu.querySelectorAll('.wallet-menu-item')].map(node => node.textContent);
    expect(items).toContain('View as another account…');
    expect(items).toContain('View as connected wallet');
    expect(items).not.toContain('Copy address');
    expect(items).not.toContain('Disconnect');
    expect(items.at(-1)).toBe('View as another account…');
    [...menu.querySelectorAll('.wallet-menu-item')].find(node => node.textContent === 'Account').click();
    expect(location.hash).toBe('#account/' + viewed);

    document.getElementById('connect-btn').click();
    [...document.querySelectorAll('.wallet-menu-item')]
      .find(node => node.textContent === 'View as connected wallet').click();
    expect(document.getElementById('connect-btn').textContent).toBe(entry.account);
    entry.account = null;
  });
});
