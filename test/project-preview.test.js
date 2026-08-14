import { describe, expect, it } from 'vitest';
import {
  formatPreviewBalance,
  injectProjectPreviewMeta,
  parseProjectReference,
  projectPreviewSlogan,
  renderProjectPreviewPng,
} from '../src/project-preview-server.mjs';

describe('project link previews', () => {
  it('parses supported project share references', () => {
    expect(parseProjectReference('base:6')).toMatchObject({
      chainId: 8453,
      projectId: 6,
      key: 'base:6',
      network: 'mainnet',
    });
    expect(parseProjectReference('basesep:6')).toMatchObject({
      chainId: 84532,
      network: 'testnet',
    });
    expect(parseProjectReference('base:0')).toBeNull();
    expect(parseProjectReference('base:6/owners')).toBeNull();
  });

  it('keeps different accounting tokens separate', () => {
    expect(
      formatPreviewBalance([
        { balance: '1500000000000000000', decimals: 18, tokenSymbol: 'ETH' },
        { balance: '2500000', decimals: 6, tokenSymbol: 'USDC' },
      ]),
    ).toBe('1.5 ETH + 2.5 USDC');
  });

  it('uses a plain-text description when a project has no tagline', () => {
    expect(projectPreviewSlogan(null, '<p>Join our <b>creative</b> mission.</p>')).toBe(
      'Join our creative mission.',
    );
  });

  it('injects crawler metadata ahead of the static defaults', () => {
    const html = injectProjectPreviewMeta('<html><head><meta property="og:title" content="Default" data-default-preview><title>Default</title></head></html>', {
      name: 'Artizen',
      tagline: 'Fund the arts.',
    }, {
      pageUrl: 'https://scan.example/?project=base%3A6',
      imageUrl: 'https://scan.example/project-og.png?project=base%3A6',
    });
    expect(html.indexOf('Artizen — Juice Scan')).toBeLessThan(html.indexOf('<title>Default</title>'));
    expect(html).toContain('property="og:image"');
    expect(html).toContain('summary_large_image');
    expect(html).not.toContain('content="Default" data-default-preview');
  });

  it('renders a crawler-compatible PNG card without a project logo', async () => {
    const image = await renderProjectPreviewPng({
      name: 'Artizen',
      tagline: 'Fund the arts.',
      logoUri: null,
      balance: '4 USDC',
      paymentsCount: 12,
    }, null);
    expect(image.subarray(1, 4).toString()).toBe('PNG');
  });
});
