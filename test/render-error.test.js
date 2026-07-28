import { describe, expect, it } from 'vitest';
import { renderError } from '../src/errors.js';

describe('renderError input normalization', () => {
  it('renders a plain string message', () => {
    const box = renderError('Execution reverted: NOPE');
    expect(box.className).toBe('error-box error');
    expect(box.textContent).toBe('Execution reverted: NOPE');
  });

  it('accepts an Error object without crashing', () => {
    const box = renderError(new Error('Network error: HTTP 502'));
    expect(box.className).toBe('error-box warning');
    expect(box.textContent).toBe('Network error: HTTP 502');
  });

  it('accepts undefined/null without crashing and shows a generic message', () => {
    for (const input of [undefined, null]) {
      const box = renderError(input);
      expect(box.className).toBe('error-box error');
      expect(box.textContent.length).toBeGreaterThan(0);
    }
  });

  it('still classifies wallet rejections from an Error object', () => {
    const box = renderError(new Error('Transaction rejected by wallet'));
    expect(box.className).toBe('error-box muted');
  });
});
