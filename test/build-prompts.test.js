import { describe, expect, it } from 'vitest';
import { COMPONENT_SPECS, componentReproPrompt } from '../src/component-base.js';
import { conceptForTitle } from '../src/discover.js';

describe('copy build prompts', () => {
  it('gives every known component a source and a feature contract', () => {
    for (const [key, spec] of Object.entries(COMPONENT_SPECS)) {
      expect(spec.file, `${key} source`).toBeTruthy();
      expect(spec.desc, `${key} contract`).toBeTruthy();
      expect(spec.sdk, `${key} SDK starting points`).toBeTruthy();

      const prompt = componentReproPrompt(key, key);
      expect(prompt).toContain('## Outcome');
      expect(prompt).toContain('## Feature contract');
      expect(prompt).toContain('## Cross-cutting requirements');
      expect(prompt).toContain('## Verification required');
      expect(prompt).toContain('## Juice SDK starting points');
      expect(prompt).toContain('https://github.com/Bananapus/juice-sdk-v4');
      expect(prompt).toContain('@bananapus/nana-sdk-core');
      expect(prompt).toContain('intentionally implements its transaction paths independently');
      expect(prompt).not.toContain('No feature-specific SDK pointer is recorded');
      expect(prompt).toContain('Live behavior to match:');
    }
  });

  it('spells out every Pay route and its incompatible cases', () => {
    const prompt = componentReproPrompt('Pay', 'pay');

    expect(prompt).toContain('DIRECT PAY');
    expect(prompt).toContain('ROUTER PAY');
    expect(prompt).toContain('ADD TO BALANCE');
    expect(prompt).toContain('NFT CHECKOUT');
    expect(prompt).toContain('TERMINAL BUYBACK');
    expect(prompt).toContain('DIRECT POOL BUY');
    expect(prompt).toContain('SUBMIT-TIME CONSISTENCY');
    expect(prompt).toContain('verified zero-token preview');
    expect(prompt).toContain('do not approve the router as if it were a direct terminal');
    expect(prompt).toContain('treasury and reserved splits receive nothing');
    expect(prompt).toContain('buildPayTx');
    expect(prompt).toContain('previewPay');
    expect(prompt).toContain('@bananapus/nana-sdk-core/v6/direct-pay');
    expect(prompt).toContain('quoteDirectPaySwap');
  });

  it('spells out the three Cash out routes, item redemption, and route locking', () => {
    const prompt = componentReproPrompt('Cash out', 'cashout');

    expect(prompt).toContain('MANDATORY EMPTY-METADATA PREVIEW');
    expect(prompt).toContain('TREASURY ROUTE');
    expect(prompt).toContain('BUYBACK-HOOK ROUTE');
    expect(prompt).toContain('DIRECT POOL SALE');
    expect(prompt).toContain('ITEM REDEMPTION');
    expect(prompt).toContain('minTokensReclaimed MUST be zero');
    expect(prompt).toContain('same ruleset id, hook route, minimum, and metadata');
    expect(prompt).toContain('internal 100% tax routing sentinel');
    expect(prompt).toContain('@bananapus/nana-sdk-core/v6/cash-out');
    expect(prompt).toContain('getHookAwareCashOutQuote');
    expect(prompt).toContain('prepareBestCashOut');
  });

  it('does not alias surplus allowance to the payouts selector', () => {
    expect(conceptForTitle('Use surplus allowance')).toBe('allowance');
    const prompt = componentReproPrompt('Use surplus allowance', conceptForTitle('Use surplus allowance'));
    expect(prompt).toContain('useAllowanceOf(uint256 projectId');
    expect(prompt).not.toContain('sendPayoutsOf(uint256 projectId');
    expect(prompt).toContain('USE_ALLOWANCE');
    expect(prompt).toContain('no confirmed high-level `useAllowanceOf` builder');
    expect(prompt).toContain('jbMultiTerminalAbi');
  });

  it('explains both shop transfer gates and the safe owner-mint path', () => {
    const prompt = componentReproPrompt('Mint item', 'items-for-sale');
    expect(prompt).toContain('transfersPausable alone does not make an item non-transferable');
    expect(prompt).toContain('active ruleset/stage metadata bit 0');
    expect(prompt).toContain('MINT_721');
    expect(prompt).toContain('repeating the uint16 tier ID');
    expect(prompt).toContain('build721RulesetMetadata');
    expect(prompt).toContain('decode721RulesetMetadata');
    expect(prompt).toContain('jb721TiersHookAbi');
    expect(conceptForTitle('Mint item #7')).toBe('items-for-sale');
  });

  it('maps action modal titles to the complete matching feature contract', () => {
    expect(conceptForTitle('Redeem items')).toBe('cashout');
    expect(conceptForTitle('Claim credits')).toBe('claim-tokens');
    expect(conceptForTitle('Mint tokens')).toBe('mint');
    expect(conceptForTitle('Remove liquidity')).toBe('add-liquidity');
    expect(conceptForTitle('Transfer project ownership')).toBe('transfer-ownership');
    expect(conceptForTitle('Transfer revnet operator')).toBe('transfer-operator');
    expect(conceptForTitle('Repay loan #42')).toBe('loan');
  });

  it('makes generic card prompts trace code instead of guessing from a title', () => {
    const prompt = componentReproPrompt('About', null, 'discover.js');
    expect(prompt).toContain('No hand-written feature contract exists for this card');
    expect(prompt).toContain('search for the exact rendered title “About”');
    expect(prompt).toContain('Do not infer behavior from the title alone');
    expect(prompt).toContain('Do not assume an SDK helper is absent without checking');
  });
});
