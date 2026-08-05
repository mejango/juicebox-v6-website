import { describe, expect, it } from 'vitest';
import { __test, renderStages } from '../src/create-flow.js';

const { initState } = __test;

describe('project recipient controls', () => {
  it('keeps the complete project payout route visible in a wrapping native selector', () => {
    const state = initState();
    state.projectType = 'custom';
    state.chainIds = [84532];
    state.stages[0].expanded = true;
    state.stages[0].payoutMode = 'limited';
    state.stages[0].payoutRecipients = [{
      type: 'project', projectId: 0, address: '', amountEth: '10', percent: 0, preferAddToBalance: false,
    }];

    const dom = renderStages(state, function () {});
    const control = dom.querySelector('.create-wrap-select');
    expect(control).not.toBeNull();
    expect(control.querySelector('.create-wrap-select-label').textContent).toBe('Pay project | mint its tokens');
    expect(control.querySelector('select.create-wrap-select-native').getAttribute('aria-label')).toBe('Project payout route');
    expect(control.querySelector('.create-wrap-select-caret')).not.toBeNull();
  });
});
