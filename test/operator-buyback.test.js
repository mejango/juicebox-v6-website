// The operator buyback/router actions: the card must render its 4 action rows without throwing (the live render
// couldn't be exercised in the test browser — its project feed is empty), and each descriptor's buildArgs must
// encode the registry call with correctly-typed args (BigInt projectId + numeric pool params).
import { describe, it, expect } from 'vitest';
import { renderBuybackRouterCard, POWER_SET_BUYBACK_HOOK, POWER_SET_ROUTER_TERMINAL, POWER_INIT_BUYBACK_POOL, POWER_SET_BUYBACK_TWAP, materializeChainValues } from '../src/discover.js';

const NATIVE = '0x000000000000000000000000000000000000EEEe';

describe('renderBuybackRouterCard', () => {
  it('renders the card + 4 action buttons without throwing', () => {
    const card = renderBuybackRouterCard({ id: '5', chainId: 1, idByChain: { 1: 5 }, chains: [{ id: 1, name: 'Ethereum', projectId: 5 }] });
    expect(card.querySelector('.detail-card-title').textContent).toMatch(/Buyback . swap router/);
    const btns = [].slice.call(card.querySelectorAll('.powers-act')).map((b) => b.textContent);
    expect(btns).toEqual(['Set buyback hook', 'Set router terminal', 'Initialize buyback pool', 'Set TWAP window']);
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
      { fee: '3000', tickSpacing: '60', twapWindow: '1800', terminalToken: NATIVE, sqrtPriceX96: '79228162514264337593543950336' }, 1, 5n);
    expect(args).toEqual([5n, 3000n, 60n, 1800n, NATIVE, 79228162514264337593543950336n]);
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
  it('pool init defaults its pair token to the Juicebox native-token sentinel', () => {
    const tokenField = POWER_INIT_BUYBACK_POOL.fields.find((f) => f.name === 'terminalToken');
    expect(tokenField.kind).toBe('chainAddress');
    expect(tokenField.defaultValue).toBe(NATIVE);
    expect(tokenField.normalizeNativeToZero).toBeUndefined();
    expect(tokenField.nativeLabel).toMatch(/sent to initializePoolFor/i);
    expect(tokenField.help).toMatch(/native-token sentinel/i);
  });
  it('initialize pool preserves the native-token sentinel in calldata args', () => {
    const args = POWER_INIT_BUYBACK_POOL.buildArgs(
      { fee: '3000', tickSpacing: '60', twapWindow: '1800', terminalToken: NATIVE, sqrtPriceX96: '79228162514264337593543950336' }, 1, 5n);
    expect(args).toEqual([5n, 3000n, 60n, 1800n, NATIVE, 79228162514264337593543950336n]);
  });
  it('pool init resolves the pair token per chain before encoding initializePoolFor', () => {
    const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const arbUsdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    const values = {
      fee: '3000',
      tickSpacing: '60',
      twapWindow: '1800',
      terminalToken: (chainId) => chainId === 8453 ? baseUsdc : arbUsdc,
      sqrtPriceX96: '79228162514264337593543950336',
    };
    expect(POWER_INIT_BUYBACK_POOL.buildArgs(values, 8453, 5n)[4]).toBe(baseUsdc);
    expect(POWER_INIT_BUYBACK_POOL.buildArgs(values, 42161, 5n)[4]).toBe(arbUsdc);
  });
  // setTwapWindowOf is NOT on the registry — it must target the project's own resolved hook, and the hook
  // rejects anything outside [300, 172800] seconds.
  it('set TWAP window → the project hook’s setTwapWindowOf(projectId, terminalToken, newWindow)', () => {
    expect(POWER_SET_BUYBACK_TWAP.contract).toBe('JBBuybackHook');
    expect(POWER_SET_BUYBACK_TWAP.fn).toBe('setTwapWindowOf');
    expect(typeof POWER_SET_BUYBACK_TWAP.resolveTargets).toBe('function');
    expect(POWER_SET_BUYBACK_TWAP.buildArgs({ terminalToken: NATIVE, twapWindow: '1800' }, 1, 5n))
      .toEqual([5n, NATIVE, 1800n]);
  });
  it('set TWAP window rejects windows the hook would revert on', () => {
    const at = (twapWindow) => () => POWER_SET_BUYBACK_TWAP.buildArgs({ terminalToken: NATIVE, twapWindow }, 1, 5n);
    expect(at('299')).toThrow(/between 300 and 172800/);
    expect(at('172801')).toThrow(/between 300 and 172800/);
    expect(at('300')).not.toThrow();
    expect(at('172800')).not.toThrow();
  });
  it('set TWAP window resolves the pair token per chain', () => {
    const baseUsdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
    const arbUsdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
    const values = { twapWindow: '1800', terminalToken: (chainId) => chainId === 8453 ? baseUsdc : arbUsdc };
    expect(POWER_SET_BUYBACK_TWAP.buildArgs(values, 8453, 5n)[1]).toBe(baseUsdc);
    expect(POWER_SET_BUYBACK_TWAP.buildArgs(values, 42161, 5n)[1]).toBe(arbUsdc);
  });
  it('materializes chain-aware address values before descriptor buildArgs run', () => {
    const values = {
      controller: Object.assign((chainId) => chainId === 8453
        ? '0x1111111111111111111111111111111111111111'
        : '0x2222222222222222222222222222222222222222', { _chainValue: true }),
      flag: true,
    };
    expect(materializeChainValues(values, 8453)).toEqual({
      controller: '0x1111111111111111111111111111111111111111',
      flag: true,
    });
    expect(materializeChainValues(values, 42161).controller).toBe('0x2222222222222222222222222222222222222222');
  });
});
