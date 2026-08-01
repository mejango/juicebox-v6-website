import { afterEach, describe, expect, it } from 'vitest';
import { getBendystrawNetwork } from '../src/bendystraw-client.js';
import { setDiscoverNetwork } from '../src/discover.js';
import { renderDataTab } from '../src/data-tab.js';

describe('Discover/Data network synchronization', () => {
  afterEach(() => {
    setDiscoverNetwork('mainnet');
    localStorage.setItem('jb-network', 'mainnet');
    document.body.innerHTML = '';
  });

  it('switches the Discover chain universe and Bendystraw host as one state change', () => {
    setDiscoverNetwork('testnet');
    expect(getBendystrawNetwork()).toBe('testnet');
    expect(localStorage.getItem('jb-network')).toBe('testnet');

    setDiscoverNetwork('mainnet');
    expect(getBendystrawNetwork()).toBe('mainnet');
    expect(localStorage.getItem('jb-network')).toBe('mainnet');
  });

  it('re-renders the DATA tab (endpoint note + chain pills) when Discover flips the network', () => {
    document.body.innerHTML = '<div id="tab-data"></div>';
    renderDataTab();

    const note = () => document.querySelector('.bendystraw-settings-note').textContent;
    const select = () => document.querySelector('.bendystraw-settings .discover-net-select');
    expect(note()).toContain('(bendystraw.up.railway.app)');
    expect(select().value).toBe('mainnet');

    // Expand a query row so its chain pills are on-screen before the network flips.
    const preview = Array.from(document.querySelectorAll('.data-row .fn-name-preview'))
      .find(node => node.textContent === 'Mint events (payment-driven)');
    preview.closest('.data-row').querySelector('.fn-summary').click();
    expect(document.body.textContent).toContain('Ethereum');

    // Flip the network from the Discover toggle — WITHOUT touching the DATA strip.
    setDiscoverNetwork('testnet');

    expect(note()).toContain('(testnet.bendystraw.xyz)');
    expect(select().value).toBe('testnet');
    // Freshly rendered pills follow the new network.
    const preview2 = Array.from(document.querySelectorAll('.data-row .fn-name-preview'))
      .find(node => node.textContent === 'Mint events (payment-driven)');
    preview2.closest('.data-row').querySelector('.fn-summary').click();
    const pillTexts = Array.from(document.querySelectorAll('.chain-pill')).map(pill => pill.textContent);
    expect(pillTexts).toContain('Sepolia');
    expect(pillTexts).not.toContain('Ethereum');
  });
});
