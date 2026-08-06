// An approval hook is the review window on ruleset changes — the protection a project points its
// contributors at. Both the .jb draft path and the queue-ruleset prefill read a live hook address back
// into an editable form, and both must PRESERVE an address the presets don't recognize: resolving it to
// 'none' encodes approvalHook = address(0), stripping the review window from the queued ruleset with
// nothing in the diff to show it.
import { describe, expect, it } from 'vitest';
import { draftDeadlineFor } from '../src/discover.js';
import { DEADLINE_OPTIONS } from '../src/deadline-options.js';
import { getAddress } from '../src/abi-registry.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const CUSTOM_HOOK = '0x00000000000000000000000000000000DeaDBeef';
const MAINNET = 1;

describe('draftDeadlineFor', () => {
  it('preserves an unrecognized hook as the custom option, carrying its address', () => {
    expect(draftDeadlineFor(CUSTOM_HOOK, MAINNET)).toEqual({ key: 'custom', address: CUSTOM_HOOK });
  });

  it('maps a missing hook to no deadline', () => {
    expect(draftDeadlineFor(ZERO, MAINNET)).toEqual({ key: 'none', address: '' });
    expect(draftDeadlineFor('', MAINNET)).toEqual({ key: 'none', address: '' });
  });

  it('recognizes each deployed preset by address, carrying no custom address', () => {
    const presets = DEADLINE_OPTIONS.filter((option) => option.contract);
    expect(presets.length).toBeGreaterThan(0);
    let matched = 0;
    for (const option of presets) {
      const deployed = getAddress(option.contract, MAINNET);
      if (!deployed) continue;
      matched++;
      expect(draftDeadlineFor(deployed, MAINNET)).toEqual({ key: option.key, address: '' });
      // Case must not decide the match — RPCs and the registry disagree on checksumming.
      expect(draftDeadlineFor(deployed.toLowerCase(), MAINNET).key).toBe(option.key);
    }
    expect(matched).toBeGreaterThan(0);
  });

  it('never silently downgrades a real hook to "no deadline"', () => {
    // The regression: anything non-zero must keep a window, whether preset or custom.
    for (const address of [CUSTOM_HOOK, '0x1111111111111111111111111111111111111111']) {
      expect(draftDeadlineFor(address, MAINNET).key).not.toBe('none');
    }
  });
});
