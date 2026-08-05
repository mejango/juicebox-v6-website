import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQueueRulesetConfigs, renderNfts, __test } from '../src/create-flow.js';

const { initState, itemDraft } = __test;

afterEach(() => vi.restoreAllMocks());

describe('shop item editor', () => {
  it('resolves a numeric sale-split recipient as a project on its selected chain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: { project: { name: 'Shop split project', handle: null, metadata: null, suckerGroupId: '0xshop' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const state = initState();
    state.chainIds = [84532];
    const item = itemDraft();
    item.price = '1';
    item.splitOn = true;
    item.splitRecipients = [{ pct: '10', recip: '7654319', benef: '' }];
    state.shopEnabled = true;
    state.nfts = [item];

    const root = renderNfts(state, () => {});
    await vi.waitFor(() => expect(root.textContent).toContain('Shop split project'));
    const input = root.querySelector('input[placeholder*="project ID"]');
    expect(input.nextElementSibling.className).toBe('create-resolve-hint');
    expect(input.parentElement.querySelector('.create-resolve-hint.ok').textContent).toBe('Shop split project');
  });

  it('keeps split sales enabled when a positive price changes to another positive price', () => {
    const state = initState();
    const item = itemDraft();
    item.price = '0.0001';
    item.splitOn = true;
    item.splitRecipients = [{ pct: '100', recip: '11', benef: '0x1111111111111111111111111111111111111111' }];
    state.shopEnabled = true;
    state.nfts = [item];

    let renders = 0;
    const root = renderNfts(state, () => { renders += 1; });
    const priceField = Array.from(root.querySelectorAll('.create-field')).find((field) => /Price/.test(field.textContent));
    const price = priceField.querySelector('input');
    price.value = '0.0002';
    price.dispatchEvent(new Event('input', { bubbles: true }));
    price.dispatchEvent(new Event('change', { bubbles: true }));

    expect(item.price).toBe('0.0002');
    expect(item.splitOn).toBe(true);
    expect(item.splitRecipients).toHaveLength(1);
    expect(renders).toBe(0);
  });

  it('checking Reserve inventory re-renders once instead of recursing (wizard-collapse bug)', () => {
    const state = initState();
    const item = itemDraft();
    item.advOpen = true;
    state.shopEnabled = true;
    state.nfts = [item];

    let renders = 0;
    let root;
    const rerender = () => {
      renders += 1;
      if (renders > 10) throw new Error('render recursion');
      root = renderNfts(state, rerender);
    };
    root = renderNfts(state, rerender);

    const toggle = Array.from(root.querySelectorAll('.create-toggle'))
      .find((l) => /Reserve inventory/.test(l.textContent));
    const cb = toggle.querySelector('input');
    cb.checked = true;
    cb.dispatchEvent(new Event('change', { bubbles: true }));

    expect(item.reserveOn).toBe(true);
    expect(renders).toBe(1);
    expect(root.textContent).toContain('1 of');
  });

  it('preserves add-to-balance payout splits in queued ruleset calldata', () => {
    const state = initState();
    state.chainIds = [1];
    state.accepts = ['eth'];
    state.stages[0].payoutMode = 'unlimited';
    state.stages[0].payoutRecipients = [{
      type: 'project', projectId: 11, address: '', percent: 100, preferAddToBalance: true,
    }];

    const [config] = buildQueueRulesetConfigs(state, 1, 0);
    const split = config.splitGroups.flatMap((group) => group.splits)[0];
    expect(split.projectId).toBe(11);
    expect(split.preferAddToBalance).toBe(true);
    expect(split.beneficiary).toBe('0x0000000000000000000000000000000000000000');
  });
});
