// The exported "copy build prompt" specs are cross-client teaching material. Fund-access limit and payout
// amounts are DENOMINATED in the limit's currency but fixed-point scaled to the ACCOUNTING CONTEXT's
// decimals (JBMultiTerminal.sendPayoutsOf natspec; JBTerminalStore.recordPayoutFor conversion keeps the
// fixed-point scale). A USDC context means 6-dec amounts regardless of currency — the specs must never
// teach the old "price-feed currencies are always 18-dec" rule.
import { describe, it, expect } from 'vitest';
import { COMPONENT_SPECS } from '../src/component-base.js';

const KEYS = ['payouts', 'launch', 'queue-ruleset'];

describe('COMPONENT_SPECS fund-access decimals prose', () => {
  for (const key of KEYS) {
    describe(key, () => {
      const desc = COMPONENT_SPECS[key].desc;

      it('teaches the accounting-context-decimals rule', () => {
        expect(desc).toMatch(/accounting context.s decimals/i);
        expect(desc).toMatch(/6-dec/);
        expect(desc).toMatch(/USDC/);
      });

      it('does not teach the old always-18-decimal rule', () => {
        expect(desc).not.toMatch(/always 18-dec/i);
        expect(desc).not.toMatch(/always encode 18/i);
        expect(desc).not.toMatch(/18-dec, not 6/);
        expect(desc).not.toMatch(/custom (use|=|ids are) 18-dec/i);
        expect(desc).not.toMatch(/everything else -> 18/);
      });
    });
  }
});
