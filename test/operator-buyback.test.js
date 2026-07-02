// The operator buyback/router actions: the card must render its 3 action rows without throwing (the live render
// couldn't be exercised in the test browser — its project feed is empty), and each descriptor's buildArgs must
// encode the registry call with correctly-typed args (BigInt projectId + numeric pool params).
import { describe, it, expect } from 'vitest';
import { renderBuybackRouterCard, POWER_SET_BUYBACK_HOOK, POWER_SET_ROUTER_TERMINAL, POWER_INIT_BUYBACK_POOL } from '../src/discover.js';

const ZERO = '0x0000000000000000000000000000000000000000';

describe('renderBuybackRouterCard', () => {
  it('renders the card + 3 action buttons without throwing', () => {
    const card = renderBuybackRouterCard({ id: '5', chains: [{ id: 1, name: 'Ethereum' }] });
    expect(card.querySelector('.detail-card-title').textContent).toMatch(/Buyback . swap router/);
    const btns = [].slice.call(card.querySelectorAll('.powers-act')).map((b) => b.textContent);
    expect(btns).toEqual(['Set buyback hook', 'Set router terminal', 'Initialize buyback pool']);
  });
});

describe('operator buyback/router descriptors', () => {
  it('set buyback hook → JBBuybackHookRegistry.setHookFor(projectId, hook)', () => {
    expect(POWER_SET_BUYBACK_HOOK.contract).toBe('JBBuybackHookRegistry');
    expect(POWER_SET_BUYBACK_HOOK.fn).toBe('setHookFor');
    expect(POWER_SET_BUYBACK_HOOK.buildArgs({ hook: '0x1111111111111111111111111111111111111111' }, 1, 5n))
      .toEqual([5n, '0x1111111111111111111111111111111111111111']);
  });
  it('set router terminal → JBRouterTerminalRegistry.setTerminalFor(projectId, terminal)', () => {
    expect(POWER_SET_ROUTER_TERMINAL.contract).toBe('JBRouterTerminalRegistry');
    expect(POWER_SET_ROUTER_TERMINAL.fn).toBe('setTerminalFor');
    expect(POWER_SET_ROUTER_TERMINAL.buildArgs({ terminal: '0x2222222222222222222222222222222222222222' }, 1, 5n))
      .toEqual([5n, '0x2222222222222222222222222222222222222222']);
  });
  it('initialize pool → JBBuybackHookRegistry.initializePoolFor (forwards to the project hook) with numeric pool params', () => {
    // Target the REGISTRY, not the hook: the registry's initializePoolFor resolves _resolvedHookOf(projectId) and
    // forwards, so the pool initializes on whatever hook the project is configured to use (the new hook once
    // setHookFor executes), and the hook's own initializePoolFor (callable only via the registry) isn't called direct.
    expect(POWER_INIT_BUYBACK_POOL.contract).toBe('JBBuybackHookRegistry');
    expect(POWER_INIT_BUYBACK_POOL.fn).toBe('initializePoolFor');
    // uint fields arrive as decimal strings from the modal parser; buildArgs casts to BigInt.
    const args = POWER_INIT_BUYBACK_POOL.buildArgs(
      { fee: '3000', tickSpacing: '60', twapWindow: '1800', terminalToken: ZERO, sqrtPriceX96: '79228162514264337593543950336' }, 1, 5n);
    expect(args).toEqual([5n, 3000n, 60n, 1800n, ZERO, 79228162514264337593543950336n]);
  });
  it('buyback hook / router terminal pre-fill the project’s CURRENT value, with no standard-infra fallback', () => {
    const hookField = POWER_SET_BUYBACK_HOOK.fields[0];
    const termField = POWER_SET_ROUTER_TERMINAL.fields[0];
    // defaultRead pre-fills the current on-chain value; absence of `infra` means no standard-default fallback.
    expect(typeof hookField.defaultRead).toBe('function');
    expect(typeof termField.defaultRead).toBe('function');
    expect(hookField.infra).toBeUndefined();
    expect(termField.infra).toBeUndefined();
    // buildArgs send exactly what's in the field — no `|| getAddress(standard)` fallback.
    expect(POWER_SET_BUYBACK_HOOK.buildArgs({ hook: '0x3333333333333333333333333333333333333333' }, 1, 9n)).toEqual([9n, '0x3333333333333333333333333333333333333333']);
  });
  it('pool init defaults its pair token to the zero address (native ETH pool-currency convention)', () => {
    const tokenField = POWER_INIT_BUYBACK_POOL.fields.find((f) => f.name === 'terminalToken');
    expect(tokenField.defaultValue).toBe(ZERO);
  });
});
