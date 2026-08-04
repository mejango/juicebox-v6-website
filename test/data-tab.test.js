import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDataQueryPrompt, coerce, renderDataTab } from '../src/data-tab.js';
import { setBendystrawNetwork } from '../src/bendystraw-client.js';

function expandQuery(title) {
  const preview = Array.from(document.querySelectorAll('.data-row .fn-name-preview'))
    .find(node => node.textContent === title);
  expect(preview).toBeTruthy();
  const row = preview.closest('.data-row');
  row.querySelector('.fn-summary').click();
  return row;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="tab-data"></div>';
  setBendystrawNetwork('testnet');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  setBendystrawNetwork('mainnet');
});

describe('Data tab variable coercion', () => {
  it('keeps bigint variables exact and rejects unsafe numeric variables', () => {
    expect(coerce('900719925474099312345', 'bigint')).toBe('900719925474099312345');
    expect(() => coerce('9007199254740993', 'int')).toThrow(/safe integer/i);
    expect(() => coerce('1,9007199254740993', 'chain_multi')).toThrow(/safe integer/i);
  });

  it('normalizes valid addresses and rejects malformed ones', () => {
    expect(coerce('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'address')).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(() => coerce('0x1234', 'address')).toThrow(/valid 0x address/i);
  });

  it('visibly separates the project chain from the multi-chain result filter', () => {
    renderDataTab();
    const row = expandQuery('Mint events (payment-driven)');

    expect(row.querySelector('.project-chain-summary')).toBeNull();
    const projectScope = row.querySelector('.project-chain-pair');
    expect(projectScope.textContent).toContain('Project ID');
    expect(projectScope.textContent).toContain('Project chain select one');
    expect(projectScope.querySelector('.data-chain-selector').dataset.selection).toBe('single');
    expect(projectScope.querySelectorAll('.chain-pill.selected')).toHaveLength(1);
    const projectBase = Array.from(projectScope.querySelectorAll('.chain-pill'))
      .find(button => button.textContent === 'Base Sepolia');
    projectBase.click();
    expect(projectScope.querySelectorAll('.chain-pill.selected')).toHaveLength(1);
    expect(Array.from(projectScope.querySelectorAll('.chain-pill'))
      .find(button => button.textContent === 'Base Sepolia').getAttribute('aria-pressed')).toBe('true');

    const resultLabel = Array.from(row.querySelectorAll('.input-label'))
      .find(label => label.textContent.includes('Result chains'));
    expect(resultLabel.textContent).toContain('select one or more');
    const resultScope = resultLabel.closest('.input-group');
    expect(resultScope.querySelector('.data-chain-selector').dataset.selection).toBe('multiple');
    expect(resultScope.textContent).toContain('included in the results');
    expect(resultScope.querySelector('.chain-pill.selected').textContent).toBe('All');
    Array.from(resultScope.querySelectorAll('.chain-pill'))
      .find(button => button.textContent === 'Base Sepolia').click();
    Array.from(resultScope.querySelectorAll('.chain-pill'))
      .find(button => button.textContent === 'Arbitrum Sepolia').click();
    expect(Array.from(resultScope.querySelectorAll('.chain-pill.selected')).map(button => button.textContent))
      .toEqual(['Base Sepolia', 'Arbitrum Sepolia']);
  });

  it('always selects a required project chain from the active network', () => {
    setBendystrawNetwork('mainnet');
    renderDataTab();
    const row = expandQuery('NFTs in project');
    expect(row.querySelector('.project-chain-pair .chain-pill.selected').textContent).toBe('Ethereum');
  });

  it('copies both the exact GraphQL query and a build prompt', async () => {
    renderDataTab();
    const row = expandQuery('NFTs in project');
    const buttons = row.querySelectorAll('.data-query-copy-link');
    expect(Array.from(buttons).map(button => button.textContent)).toEqual(['[copy query]', '[copy build prompt]']);

    buttons[0].click();
    await Promise.resolve();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(expect.stringContaining('query($projectId: Int!, $chainId: Int!'));

    buttons[1].click();
    await Promise.resolve();
    const prompt = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(prompt).toContain('Build a client-only, read-only Juicebox V6 data view for “NFTs in project”');
    expect(prompt).toContain('src/data-tab.js');
    expect(prompt).toContain('visible, single-select Project chain');
    expect(prompt).not.toContain('Label chainIds as Result chains');
  });

  it('describes sucker-group resolution separately from result-chain filtering in prompts', () => {
    const prompt = buildDataQueryPrompt({
      title: 'Mint events', hint: 'Across the group.', path: 'mintTokensEvents', resolveSuckerGroup: true,
      query: 'query($suckerGroupId: String!) { mintTokensEvents { totalCount } }',
      variables: [{ name: 'projectId', type: 'int' }, { name: 'chainIds', type: 'chain_multi', optional: true }],
      columns: [{ key: 'chainId', label: 'Chain', format: 'chainName' }],
    });
    expect(prompt).toContain('single Project chain');
    expect(prompt).toContain('multi-select Result chains');
    expect(prompt).toContain('suckerGroupId');
    expect(prompt).toContain('https://github.com/Bananapus/juice-sdk-v4');
    expect(prompt).toContain('@bananapus/nana-sdk-core');
    expect(prompt).toContain('packages/core/src/utils/bendystraw.ts');
    expect(prompt).toContain('normalizeBendystrawEndpoint');
  });

  it('exposes Bendystraw pool registration and exact post-swap AMM history', async () => {
    renderDataTab();

    const poolRow = expandQuery('Buyback pool registrations');
    expect(poolRow.textContent).toContain('initialSqrtPriceX96');
    expect(poolRow.textContent).toContain('projectTokenIsCurrency0');
    expect(poolRow.textContent).toContain('nullable on legacy rows');
    const poolButtons = poolRow.querySelectorAll('.data-query-copy-link');
    poolButtons[1].click();
    await Promise.resolve();
    const poolPrompt = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(poolPrompt).toContain('buybackPoolEvents');
    expect(poolPrompt).toContain('version: 6');
    expect(poolPrompt).toContain('exact chainId and poolId');

    const swapRow = expandQuery('AMM swap price history');
    expect(swapRow.textContent).toContain('exact post-swap V4 spot');
    expect(swapRow.textContent).toContain('realized average price, not an exact spot');
    const swapButtons = swapRow.querySelectorAll('.data-query-copy-link');
    swapButtons[1].click();
    await Promise.resolve();
    const swapPrompt = navigator.clipboard.writeText.mock.calls.at(-1)[0];
    expect(swapPrompt).toContain('swapEvents');
    expect(swapPrompt).toContain('sqrtPriceX96');
    expect(swapPrompt).toContain('projectTokenIsCurrency0');
    expect(swapPrompt).toContain('10^(18 − terminalDecimals)');
    expect(swapPrompt).toContain("read terminalDecimals from the project's accounting context");
    expect(swapPrompt).toContain('direction mint does not touch the pool');
    expect(swapPrompt).toContain('exact chainId and poolId');
  });
});
