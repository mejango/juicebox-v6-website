// Modality is a browser behavior — jsdom cannot express the top layer, inertness or focus restoration,
// so the guarantees the modal migration is built on are proven here, in Chromium, against the real
// src/discover.js `openModal` and the real stylesheet the site ships.
//
// The helper is module-private to the IIFE bundle, so the spec serves an ES-module harness that
// re-exports it from the same sources dist/app.js is built from. It is fulfilled from a same-origin URL
// because the page's CSP is `script-src 'self'` (inline script tags are correctly refused).
import * as esbuild from 'esbuild';
import { expect, test } from '@playwright/test';

const HARNESS_URL = '/e2e-modal-harness.js';
const CHAIN_IDS = [1, 10, 8453, 42161, 11155111, 11155420, 84532, 421614];
let harness = null;

function harnessSource() {
  if (!harness) {
    harness = esbuild.build({
      stdin: {
        contents: "import { openModal } from './src/discover.js';\nimport { openCreateFlow, renderStages, __test } from './src/create-flow.js';\nwindow.__jbModalHarness = { openModal: openModal, openCreateFlow: openCreateFlow, renderStages: renderStages, createState: __test.initState };\n",
        resolveDir: process.cwd(),
        sourcefile: 'e2e-modal-harness.js',
        loader: 'js',
      },
      bundle: true,
      format: 'esm',
      write: false,
      define: { __BENDYSTRAW_API_KEY__: '""', __PINATA_JWT__: '""' },
    }).then(result => result.outputFiles[0].text);
  }
  return harness;
}

// Opens the real site with the launchers installed: one button on the page, and — inside the modal it
// opens — a second one, so every showModal() call carries the user activation a real click gives it.
async function openLauncherPage(page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(chainIds => {
    const localRpc = `${window.location.origin}/__ci_rpc__`;
    for (const chainId of chainIds) localStorage.setItem(`jb-rpc-${chainId}`, localRpc);
  }, CHAIN_IDS);
  const externalAttempts = [];
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    externalAttempts.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  // Registered last so it wins over the catch-all above.
  const source = await harnessSource();
  await page.route(`**${HARNESS_URL}`, route => route.fulfill({
    contentType: 'text/javascript; charset=utf-8',
    body: source,
  }));

  await page.goto('/index.html#learn', { waitUntil: 'domcontentloaded' });
  await page.addScriptTag({ url: HARNESS_URL, type: 'module' });
  await page.waitForFunction(() => !!window.__jbModalHarness);

  await page.evaluate(() => {
    window.__modalClicks = [];
    const launcher = (id, title, build) => {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.id = `open-${id}`;
      trigger.textContent = `Open ${title}`;
      trigger.addEventListener('click', () => {
        const body = document.createElement('div');
        body.className = 'modal-body';
        const action = document.createElement('button');
        action.type = 'button';
        action.id = `action-${id}`;
        action.textContent = `Act ${id}`;
        action.addEventListener('click', () => window.__modalClicks.push(id));
        body.appendChild(action);
        if (build) body.appendChild(build());
        window.__jbModalHarness.openModal(title, body);
      });
      return trigger;
    };
    document.querySelector('main').appendChild(
      launcher('first', 'First modal', () => launcher('second', 'Second modal', null)),
    );
  });
  return { externalAttempts };
}

const dialogs = page => page.locator('dialog.modal-dialog');

async function clickIsBlocked(locator) {
  try {
    await locator.click({ timeout: 1200 });
    return false;
  } catch {
    return true;
  }
}

const canFocus = (page, selector) => page.evaluate(id => {
  const node = document.getElementById(id);
  node.focus();
  return document.activeElement === node;
}, selector);

test('a modal opens in the top layer, seals the page behind it, and restores on close', async ({ page }) => {
  const { externalAttempts } = await openLauncherPage(page);
  await expect(page.locator('#open-first')).toBeVisible();

  await page.click('#open-first');
  await expect(dialogs(page)).toHaveCount(1);
  const dialog = dialogs(page).first();
  await expect(dialog).toBeVisible();

  // The dimming layer is ::backdrop now — the same color the overlay div used to paint, and it is the
  // hit-test target for clicks outside the panel (the click-outside-to-close contract).
  const backdrop = await page.evaluate(() => {
    const node = document.querySelector('dialog.modal-dialog');
    return {
      open: node.open,
      color: getComputedStyle(node, '::backdrop').backgroundColor,
      cornerTag: document.elementFromPoint(3, 3).tagName,
      labelledBy: document.getElementById(node.getAttribute('aria-labelledby')).textContent,
      overlays: document.querySelectorAll('.modal-overlay').length,
    };
  });
  expect(backdrop.open).toBe(true);
  expect(backdrop.color).toBe('rgba(44, 32, 24, 0.45)');
  expect(backdrop.cornerTag).toBe('DIALOG');
  expect(backdrop.labelledBy).toBe('First modal');
  expect(backdrop.overlays).toBe(0);

  // Geometry the old overlay produced: 48px from the top, centered, 16px side gutters, 480px cap.
  const geometry = await page.evaluate(() => {
    const rect = document.querySelector('dialog.modal-dialog').getBoundingClientRect();
    return { top: rect.top, left: rect.left, right: rect.right, width: rect.width, viewport: document.documentElement.clientWidth };
  });
  expect(geometry.top).toBeCloseTo(48, 0);
  expect(geometry.width).toBeCloseTo(Math.min(480, geometry.viewport - 32), 0);
  expect(geometry.left).toBeCloseTo(geometry.viewport - geometry.right, 0);

  // Inside the modal is live…
  await page.click('#action-first');
  expect(await page.evaluate(() => window.__modalClicks)).toEqual(['first']);
  // …everything behind it is not: not clickable, not focusable, not reachable by Tab.
  expect(await clickIsBlocked(page.locator('#open-first'))).toBe(true);
  expect(await canFocus(page, 'open-first')).toBe(false);
  await expect(dialogs(page)).toHaveCount(1); // the blocked click never re-opened anything
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.querySelector('dialog.modal-dialog').contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialogs(page)).toHaveCount(0);

  // Focus goes back to the control that opened the modal, and the page is usable again.
  expect(await page.evaluate(() => document.activeElement.id)).toBe('open-first');
  expect(await canFocus(page, 'open-first')).toBe(true);
  await page.click('#open-first');
  await expect(dialogs(page)).toHaveCount(1);
  expect(externalAttempts).toEqual([]);
});

test('a stacked modal is interactive above the one beneath, and Escape closes only the top', async ({ page }) => {
  await openLauncherPage(page);
  await page.click('#open-first');
  await page.click('#open-second');
  await expect(dialogs(page)).toHaveCount(2);

  // Newest on top and interactive; the modal beneath it is inert, exactly like the page behind both.
  await page.click('#action-second');
  expect(await page.evaluate(() => window.__modalClicks)).toEqual(['second']);
  expect(await clickIsBlocked(page.locator('#action-first'))).toBe(true);
  expect(await canFocus(page, 'action-first')).toBe(false);

  // The bug this migration fixes: one Escape used to close every stacked modal at once.
  await page.keyboard.press('Escape');
  await expect(dialogs(page)).toHaveCount(1);
  expect(await page.evaluate(() => document.querySelector('dialog.modal-dialog .modal-title').textContent)).toBe('First modal');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('open-second');

  // With the top modal gone the first one is live again.
  await page.click('#action-first');
  expect(await page.evaluate(() => window.__modalClicks)).toEqual(['second', 'first']);

  await page.keyboard.press('Escape');
  await expect(dialogs(page)).toHaveCount(0);
  expect(await canFocus(page, 'open-first')).toBe(true);
});

test('a modal opened from the create wizard takes Escape without closing the wizard', async ({ page }) => {
  await openLauncherPage(page);
  await page.evaluate(() => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.id = 'open-wizard';
    trigger.textContent = 'Open wizard';
    trigger.addEventListener('click', () => {
      window.__jbModalHarness.openCreateFlow();
      // A launcher inside the wizard, standing in for its own "review this transaction" step.
      const inner = document.createElement('button');
      inner.type = 'button';
      inner.id = 'open-from-wizard';
      inner.textContent = 'Review';
      inner.addEventListener('click', () => window.__jbModalHarness.openModal('Confirm transaction', document.createElement('div')));
      document.querySelector('dialog.create-overlay .create-sheet').appendChild(inner);
    });
    document.querySelector('main').appendChild(trigger);
  });

  await page.click('#open-wizard');
  const wizard = page.locator('dialog.create-overlay');
  await expect(wizard).toHaveCount(1);
  expect(await page.evaluate(() => ({
    open: document.querySelector('dialog.create-overlay').open,
    backdrop: getComputedStyle(document.querySelector('dialog.create-overlay'), '::backdrop').backgroundColor,
    sheetTop: document.querySelector('.create-sheet').getBoundingClientRect().top,
  }))).toEqual({ open: true, backdrop: 'rgba(44, 32, 24, 0.5)', sheetTop: 32 });

  await page.click('#open-from-wizard');
  await expect(dialogs(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(dialogs(page)).toHaveCount(0);
  await expect(wizard).toHaveCount(1); // the wizard used to die on this same keypress
  expect(await page.evaluate(() => document.querySelector('dialog.create-overlay').open)).toBe(true);

  await page.keyboard.press('Escape');
  await expect(wizard).toHaveCount(0);
});

test('a click on the backdrop closes the modal, a click inside it does not', async ({ page }) => {
  await openLauncherPage(page);
  await page.click('#open-first');
  await expect(dialogs(page)).toHaveCount(1);

  await page.locator('dialog.modal-dialog .modal-panel').click({ position: { x: 4, y: 4 } });
  await expect(dialogs(page)).toHaveCount(1); // panel padding is inside the modal, not the backdrop

  await page.mouse.click(3, 3);
  await expect(dialogs(page)).toHaveCount(0);
});

test('the project payout route wraps without truncation and keeps its native caret centered', async ({ page }) => {
  await openLauncherPage(page);
  const result = await page.evaluate(() => {
    const state = window.__jbModalHarness.createState();
    state.projectType = 'custom';
    state.chainIds = [84532];
    state.stages[0].expanded = true;
    state.stages[0].payoutMode = 'limited';
    state.stages[0].payoutRecipients = [{
      type: 'project', projectId: 0, address: '', amountEth: '10', percent: 0, preferAddToBalance: false,
    }];
    const host = document.createElement('div');
    host.className = 'create-sheet';
    host.style.width = '180px';
    host.style.position = 'absolute';
    host.style.left = '8px';
    host.style.top = '8px';
    host.appendChild(window.__jbModalHarness.renderStages(state, () => {}));
    document.body.appendChild(host);

    const control = host.querySelector('.create-wrap-select');
    control.style.width = '140px';
    const label = control.querySelector('.create-wrap-select-label');
    const caret = control.querySelector('.create-wrap-select-caret');
    const native = control.querySelector('select.create-wrap-select-native');
    native.focus();
    const controlRect = control.getBoundingClientRect();
    const caretRect = caret.getBoundingClientRect();
    const nativeRect = native.getBoundingClientRect();
    const style = getComputedStyle(control);
    return {
      text: label.textContent,
      controlHeight: controlRect.height,
      labelFitsWidth: label.scrollWidth <= label.clientWidth + 1,
      labelFitsHeight: label.scrollHeight <= label.clientHeight + 1,
      caretCenterDelta: Math.abs(
        (caretRect.top + caretRect.height / 2) - (controlRect.top + controlRect.height / 2),
      ),
      controlSize: [controlRect.width, controlRect.height],
      nativeSize: [nativeRect.width, nativeRect.height],
      focusStyle: style.outlineStyle,
      focusWidth: Number.parseFloat(style.outlineWidth),
    };
  });

  expect(result.text).toBe('Pay project | mint its tokens');
  expect(result.controlHeight).toBeGreaterThan(34);
  expect(result.labelFitsWidth).toBe(true);
  expect(result.labelFitsHeight).toBe(true);
  expect(result.caretCenterDelta).toBeLessThanOrEqual(2.5);
  expect(result.nativeSize).toEqual(result.controlSize);
  expect(result.focusStyle).not.toBe('none');
  expect(result.focusWidth).toBeGreaterThanOrEqual(2);
});
