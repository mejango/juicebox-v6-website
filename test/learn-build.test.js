import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderBuildTab, renderLearnTab, renderWhyTab } from '../src/learn-build.js';

function assertTableOfContents(container) {
  const links = [...container.querySelectorAll('.guide-toc-link')];
  expect(links.length).toBeGreaterThan(10);
  for (const link of links) {
    const target = container.querySelector(link.getAttribute('href'));
    expect(target, `missing target for ${link.getAttribute('href')}`).not.toBeNull();
  }
}

describe('Learn, Build, and Why guides', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><section id="tab-learn"></section><section id="tab-build"></section><section id="tab-why"></section></main>';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('renders every documented section and keeps every table-of-contents link local and valid', () => {
    renderLearnTab();
    renderBuildTab();
    renderWhyTab();

    const learn = document.getElementById('tab-learn');
    const build = document.getElementById('tab-build');
    const why = document.getElementById('tab-why');
    assertTableOfContents(learn);
    assertTableOfContents(build);
    expect(learn.querySelectorAll('.guide-section').length).toBe(21);
    expect(build.querySelectorAll('.guide-section').length).toBe(21);
    expect(why.querySelectorAll('.why-want').length).toBe(12);
    expect(why.textContent).toMatch(/freedom to earn their money, on their terms/i);

    for (const heading of document.querySelectorAll('.guide-section-title')) {
      expect(heading.tagName).toBe('H2');
      expect(heading.querySelector('button[aria-label="Copy link to this section"]')).not.toBeNull();
    }
    for (const scrollRegion of document.querySelectorAll('.guide-code, .guide-diagram')) {
      expect(scrollRegion.tabIndex).toBe(0);
    }
    for (const link of document.querySelectorAll('a[target="_blank"]')) {
      expect(new Set((link.rel || '').split(/\s+/))).toContain('noopener');
    }
  });

  it('smooth-scrolls guide links and copies stable deep links', async () => {
    renderLearnTab();
    const target = document.getElementById('learn-what');
    target.scrollIntoView = vi.fn();

    document.querySelector('a[href="#learn-what"]').click();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });

    target.querySelector('.guide-copy-link').click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`${location.origin}${location.pathname}${location.search}#learn-what`);
  });

  it('copies the agent build prompt and confirms it in the button', async () => {
    renderBuildTab();
    const button = document.querySelector('.guide-agent-prompt button');

    button.click();
    await vi.waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    const prompt = navigator.clipboard.writeText.mock.calls[0][0];
    expect(prompt).toContain('Juicebox V6');
    expect(prompt).toContain('https://github.com/Bananapus/version-6');
    expect(prompt).toContain('https://github.com/mejango/juicescan');
    expect(prompt).toContain('do not substitute older Juicebox versions');
    await vi.waitFor(() => expect(button.textContent).toBe('Build prompt copied'));
  });

  it('copies the agent build prompt without a clipboard API', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    document.execCommand = vi.fn();
    renderBuildTab();

    document.querySelector('.guide-agent-prompt button').click();

    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(document.querySelector('.guide-agent-prompt button').textContent).toBe('Build prompt copied');
  });

  it('tolerates the optional Why surface being absent', () => {
    document.getElementById('tab-why').remove();
    expect(() => renderWhyTab()).not.toThrow();
  });
});
