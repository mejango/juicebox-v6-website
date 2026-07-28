// The hidden ACTIONS launch widget executes a single launchProjectFor on ONE chain, so its chain
// picker must be single-select (radio semantics) — the old multi-select silently dropped every
// chain after chainIds[0]. Omnichain launches belong to the create wizard.
import { describe, it, expect } from 'vitest';
import { renderLaunchComponent } from '../src/launch-component.js';

describe('ACTIONS launch widget chain picker', () => {
  it('is single-select: picking a chain replaces the selection', () => {
    const dom = renderLaunchComponent();
    document.body.innerHTML = '';
    document.body.appendChild(dom);
    const pills = () => [...dom.querySelectorAll('.chain-pill')];
    expect(pills().length).toBeGreaterThan(1);
    expect(pills().filter((p) => p.classList.contains('selected')).map((p) => p.textContent)).toEqual(['Ethereum']);
    pills().find((p) => p.textContent === 'Base').click();
    expect(pills().filter((p) => p.classList.contains('selected')).map((p) => p.textContent)).toEqual(['Base']);
    // Clicking another chain moves the selection — it never grows to two.
    pills().find((p) => p.textContent === 'Optimism').click();
    expect(pills().filter((p) => p.classList.contains('selected')).map((p) => p.textContent)).toEqual(['Optimism']);
  });

  it('labels the picker honestly', () => {
    const dom = renderLaunchComponent();
    expect(dom.textContent).toContain('pick a chain');
    expect(dom.textContent).not.toContain('pick one or more');
  });
});
