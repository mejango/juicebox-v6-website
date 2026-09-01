// UI smoke tests — exercise the live app's critical UX paths so future changes can't silently break them.
// By default this serves dist/ on an ephemeral localhost port and launches an isolated headless Brave profile.
// Run: NODE_PATH=$(cat /tmp/pwc_path.txt) node test/ui-smoke.mjs    (or: npm run test:ui)
// Legacy live-browser mode is explicit: UI_SMOKE_LIVE_CDP=1 (expects the old localhost:8799 + Brave:9222 harness).
// Exits non-zero if any scenario fails, so it can gate changes in CI/pre-push.
import { createRequire } from 'module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

let BASE = 'http://localhost:8799/index.html';
let pass = 0, fail = 0;
const results = [];
function check(name, ok, info) { (ok ? pass++ : fail++); results.push((ok ? 'PASS ' : 'FAIL ') + name + (info && !ok ? '  → ' + info : '')); }

async function startIsolatedServer() {
  const root = fileURLToPath(new URL('../dist/', import.meta.url));
  const contentTypes = { '.css': 'text/css', '.gif': 'image/gif', '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      if (relative.split('/').includes('..')) { response.writeHead(403).end(); return; }
      const file = join(root, relative);
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': contentTypes[extname(file)] || 'application/octet-stream' });
      response.end(body);
    } catch (_) {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function freshCreateFlow(page, r) {
  await page.goto(BASE + '?r=' + r + '#discover', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { try { localStorage.removeItem('jb-create-draft'); localStorage.setItem('jb-network', 'mainnet'); } catch (e) {} });
  await page.goto(BASE + '?r=' + (r + 1) + '#discover', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button,a,.tab')].find(x => /New project/i.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(1100);
}
const Q = (page, fn) => page.evaluate(new Function('return (' + fn + ')()'));

(async () => {
  const isolated = process.env.UI_SMOKE_LIVE_CDP !== '1';
  const staticServer = isolated ? await startIsolatedServer() : null;
  if (staticServer) BASE = 'http://127.0.0.1:' + staticServer.address().port + '/index.html';
  const browser = isolated
    ? await chromium.launch({
      headless: true,
      executablePath: process.env.UI_SMOKE_BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    })
    : await chromium.connectOverCDP('http://localhost:9222');
  const ctx = isolated ? await browser.newContext() : browser.contexts()[0];
  let page = ctx.pages().find(p => p.url().includes('localhost:8799')) || ctx.pages()[0] || await ctx.newPage();
  await page.setViewportSize({ width: 1100, height: 1000 });

  try {
    // 1. Discover renders project cards.
    await page.goto(BASE + '?r=500#discover', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.discover-card:not(.discover-card--loading)', { timeout: 20000 });
    const cards = await Q(page, '() => document.querySelectorAll(".discover-card:not(.discover-card--loading)").length');
    check('discover renders project cards', cards > 0, 'cards=' + cards);

    // 1a. Mobile browsers without an injected provider offer wallet-app handoffs and the native share sheet.
    await Q(page, `() => {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.__sharedWalletUrl = data.url; } });
      document.querySelector('#connect-btn').click();
      return 1;
    }`);
    // MetaMask Mobile documents a late-injection window of up to three
    // seconds. With no provider in this browser fixture, the app waits out
    // that window before presenting wallet-app handoffs.
    await page.waitForTimeout(3150);
    const mobileWalletMenu = await Q(page, `() => {
      const menu = document.querySelector('.wallet-menu');
      const links = [...menu.querySelectorAll('a')].map(a => a.textContent.trim());
      const more = [...menu.querySelectorAll('button')].find(b => b.textContent.trim() === 'Open another wallet…');
      if (more) more.click();
      return {
        note: menu.querySelector('.wallet-menu-note').textContent.trim(),
        links,
        hasMore: !!more,
        pageUrl: location.href,
        borderRadius: getComputedStyle(menu).borderRadius,
      };
    }`);
    await page.waitForTimeout(50);
    const sharedWalletUrl = await Q(page, '() => window.__sharedWalletUrl');
    check('mobile connect offers wallet apps and a share-sheet fallback',
      mobileWalletMenu.note === 'Choose a wallet app to continue. This page will reopen there.'
        && ['Open in MetaMask', 'Open in Coinbase Wallet', 'Open in Trust Wallet'].every(x => mobileWalletMenu.links.includes(x))
        && mobileWalletMenu.hasMore && sharedWalletUrl === mobileWalletMenu.pageUrl
        && mobileWalletMenu.borderRadius === '0px',
      JSON.stringify({ mobileWalletMenu, sharedWalletUrl }));
    await Q(page, '() => { document.querySelector("#connect-btn").click(); return 1; }');

    // 1b. Payer-address copy names the exact direct-transfer and admin boundaries.
    await Q(page, '() => { document.querySelector(".discover-card:not(.discover-card--loading)").click(); return 1; }');
    await page.waitForTimeout(500);
    const inlineOverflow = await Q(page, `() => {
      const toggle = document.querySelector('.detail-tab-overflow-button');
      const extras = document.querySelector('.detail-tab-overflow-item[data-tab=Extras]');
      toggle.click();
      const expanded = !extras.hidden && toggle.dataset.overflowOrientation === 'horizontal';
      toggle.click();
      const collapsed = extras.hidden && toggle.dataset.overflowOrientation === 'vertical';
      toggle.click();
      extras.click();
      return { expanded, collapsed, stillExpanded: !extras.hidden };
    }`);
    check('project admin tabs expand inline and collapse only from the ellipsis',
      inlineOverflow.expanded && inlineOverflow.collapsed && inlineOverflow.stillExpanded,
      JSON.stringify(inlineOverflow));
    await page.waitForTimeout(250);
    await Q(page, '() => { [...document.querySelectorAll(".extras-card button")].find(b=>b.textContent.trim()==="Create payer address").click(); return 1; }');
    const payerCopy = await Q(page, '() => { const card=document.querySelector(".extras-card"); const modal=document.querySelector(".modal-dialog"); const editable=modal.querySelector(".extras-editable-row input"); editable.click(); return { title:card.querySelector(".detail-card-title").textContent.trim(), body:card.textContent+modal.textContent, admin:modal.textContent }; }');
    check('payer address copy specifies native ETH, direct ERC-20, immutable defaults, and admin powers',
      payerCopy.title === 'Payer address' && payerCopy.body.includes('native token (ETH)')
        && payerCopy.body.includes('ERC-20 tokens directly') && payerCopy.body.includes('are permanent')
        && payerCopy.admin.includes('transfer or renounce the admin role') && payerCopy.admin.includes('does not receive payments or control either project'),
      JSON.stringify(payerCopy));

    // 1c. The reported Base Sepolia payout path presents one compact source of truth and no disabled one-option select.
    await page.goto(BASE + '?r=502#basesep:10/funds', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Distribute payouts'), null, { timeout: 20000 });
    await Q(page, '() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Distribute payouts").click(); return 1; }');
    await page.waitForSelector('.payout-summary:not([hidden])', { timeout: 20000 });
    const payoutModal = await Q(page, `() => {
      const modal = document.querySelector('.modal-dialog');
      const body = modal.querySelector('.modal-body');
      const rows = [...modal.querySelectorAll('.payout-summary tr')].map(row => [...row.children].map(cell => cell.textContent.trim()));
      const input = modal.querySelector('.ops-amount');
      input.value = '0.01'; input.dispatchEvent(new Event('input', { bubbles: true }));
      const currency = modal.querySelector('.payout-currency-row');
      return {
        title: modal.querySelector('.modal-title').textContent.trim(), rows,
        currencyHidden: currency.hidden, fieldGrows: input.parentElement.classList.contains('ops-field--grow'),
        text: body.textContent,
      };
    }`);
    check('payout modal shows limit/balance/available table with concise copy',
      payoutModal.title === 'Distribute payouts'
        && ['Limit remaining', 'Terminal balance', 'Available now'].every((label, i) => payoutModal.rows[i] && payoutModal.rows[i][0] === label)
        && payoutModal.currencyHidden && payoutModal.fieldGrows
        && !payoutModal.text.includes('↳') && !payoutModal.text.includes('paid into') && !payoutModal.text.includes('Before confirmation'),
      JSON.stringify(payoutModal));
    await Q(page, '() => { document.querySelector(".modal-close").click(); return 1; }');
    await Q(page, '() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Use surplus allowance").click(); return 1; }');
    await page.waitForFunction(() => {
      const modal = document.querySelector('.modal-dialog');
      if (!modal) return false;
      const summary = modal.querySelector('.payout-summary');
      const message = [...modal.querySelectorAll('.modal-balance')].map(node => node.textContent.trim()).join(' ');
      return (summary && !summary.hidden) || (message && !message.includes('Loading allowance'));
    }, null, { timeout: 20000 });
    const allowanceModal = await Q(page, `() => {
      const modal = document.querySelector('.modal-dialog');
      const currency = modal.querySelector('.access-currency-row');
      const field = modal.querySelector('.ops-field');
      const summary = modal.querySelector('.payout-summary');
      const bounds = modal.getBoundingClientRect();
      const contained = [...modal.querySelectorAll('.payout-summary th, .payout-summary td, .ops-field')]
        .every(node => { const rect = node.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1; });
      return {
        rows: [...modal.querySelectorAll('.payout-summary tr')].map(row => [...row.children].map(cell => cell.textContent.trim())),
        summaryVisible: !summary.hidden,
        message: [...modal.querySelectorAll('.modal-balance')].map(node => node.textContent.trim()).filter(Boolean).join(' '),
        currencyHidden: currency.hidden, fieldGrows: field.classList.contains('ops-field--grow'),
        noHorizontalOverflow: contained,
      };
    }`);
    check('surplus allowance keeps exact amounts inside a compact full-width layout',
      (allowanceModal.summaryVisible
        ? ['Allowance remaining', 'Current surplus', 'Available now'].every((label, i) => allowanceModal.rows[i] && allowanceModal.rows[i][0] === label)
          && allowanceModal.rows[0][1].startsWith('Unlimited')
          && allowanceModal.currencyHidden && allowanceModal.fieldGrows && allowanceModal.noHorizontalOverflow
        : allowanceModal.message.includes('No surplus allowance is configured')),
      JSON.stringify(allowanceModal));
    await Q(page, '() => { document.querySelector(".modal-body").dispatchEvent(new CustomEvent("jb:close-modal")); return 1; }');
    check('completed allowance flow can close its stale modal',
      await Q(page, '() => !document.querySelector(".modal-dialog")'));

    // 1d. Base Sepolia #8 has floor/price/ceiling clustered at the same end of both LP charts.
    await page.goto(BASE + '?r=504#basesep:8/owners/market', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.lp-depth-svg', { timeout: 30000 });
    const depthMarkers = await Q(page, `() => {
      const labels = [...document.querySelectorAll('.lp-depth-svg text')]
        .filter(node => ['floor', 'price', 'ceiling'].includes(node.textContent.trim()))
        .map(node => ({ text: node.textContent.trim(), box: node.getBoundingClientRect().toJSON() }));
      const overlaps = labels.some((a, i) => labels.slice(i + 1).some(b =>
        a.box.left < b.box.right && a.box.right > b.box.left && a.box.top < b.box.bottom && a.box.bottom > b.box.top));
      const intro = [...document.querySelectorAll('.owners-intro')]
        .map(node => node.textContent.trim()).find(text => text.startsWith('The market is used')) || '';
      return { labels, overlaps, intro };
    }`);
    check('LP depth floor/price/ceiling labels do not overlap',
      ['price', 'ceiling'].every(label => depthMarkers.labels.some(marker => marker.text === label))
        && !depthMarkers.overlaps,
      JSON.stringify(depthMarkers));
    check('market copy uses the project token symbol instead of hardcoded REV',
      depthMarkers.intro.includes('TEST') && !/\bREV\b/.test(depthMarkers.intro), depthMarkers.intro);

    await page.goto(BASE + '?r=505#basesep:8/owners/accounts', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add liquidity'), null, { timeout: 20000 });
    await Q(page, '() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Add liquidity").click(); return 1; }');
    await page.waitForSelector('.modal-dialog .lp-graph-svg', { timeout: 30000 });
    const liquidityRange = await Q(page, `() => {
      const modal = document.querySelector('.modal-dialog');
      const labels = [...modal.querySelectorAll('.lp-graph-svg text')]
        .filter(node => ['Floor', 'Ceiling'].includes(node.textContent.trim()))
        .map(node => ({ text: node.textContent.trim(), box: node.getBoundingClientRect().toJSON() }));
      const overlap = labels.some((a, i) => labels.slice(i + 1).some(b =>
        a.box.left < b.box.right && a.box.right > b.box.left
        && a.box.top < b.box.bottom && a.box.bottom > b.box.top));
      const range = [...modal.querySelectorAll('.ops-rangerow input')].map(input => Number(input.value));
      const sides = [...modal.querySelectorAll('.lp-add-col input')];
      return {
        labels, overlap, range,
        bothSidesEnabled: sides.length === 2 && sides.every(input => !input.disabled),
        note: [...modal.querySelectorAll('.modal-balance')].map(node => node.textContent).find(text => text.includes('default range')) || '',
      };
    }`);
    check('LP range labels separate and default range enables both deposit tokens',
      liquidityRange.labels.some(label => label.text === 'Ceiling') && !liquidityRange.overlap
        && liquidityRange.range[0] > 0 && liquidityRange.range[0] < liquidityRange.range[1]
        && liquidityRange.bothSidesEnabled && liquidityRange.note.includes('both tokens can be added'),
      JSON.stringify(liquidityRange));
    await Q(page, '() => { document.querySelector(".modal-close").click(); return 1; }');

    // 1e. The loan modal compares the real net-now choices, hides a redundant source-token selector, and
    // describes maximum prepayment as a fee that never grows.
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Get a loan'), null, { timeout: 20000 });
    await Q(page, '() => { [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Get a loan").click(); return 1; }');
    await page.waitForSelector('.modal-dialog .loan-source-row', { state: 'attached', timeout: 20000 });
    await page.waitForFunction(() => {
      const select = document.querySelector('.modal-dialog .loan-source-select');
      return select && select.options.length && !select.options[0].textContent.includes('Loading');
    }, null, { timeout: 30000 });
    await Q(page, `() => {
      const modal = document.querySelector('.modal-dialog');
      const amount = modal.querySelector('.ops-amount');
      amount.value = '10'; amount.dispatchEvent(new Event('input', { bubbles: true }));
      const slider = modal.querySelector('.loan-slider');
      slider.value = '500'; slider.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    }`);
    await page.waitForFunction(() => {
      const modal = document.querySelector('.modal-dialog');
      const rows = [...modal.querySelectorAll('.loan-decision-table tr')].map(row => row.textContent);
      const preview = modal.querySelector('.ops-preview')?.textContent || '';
      const hasLoan = modal.querySelector('.loan-summary')?.textContent.includes('Never grows');
      const settledUnavailable = preview.includes('Nothing borrowable yet') || preview.includes('Could not verify the live loan quote');
      return (hasLoan || settledUnavailable) && rows.length === 3
        && !rows[0].includes('checking') && !rows[1].includes('Checking')
        && !rows[2].includes('Checking');
    }, null, { timeout: 30000 });
    const loanModal = await Q(page, `() => {
      const modal = document.querySelector('.modal-dialog');
      return {
        sourceHidden: modal.querySelector('.loan-source-row').hidden,
        sourceOptions: [...modal.querySelector('.loan-source-select').options].map(option => option.textContent.trim()),
        rows: [...modal.querySelectorAll('.loan-decision-table tr')].map(row => [...row.children].map(cell => cell.textContent.trim())),
        note: modal.querySelector('.loan-decision-note').textContent.trim(),
        summary: modal.querySelector('.loan-summary').textContent,
        feeCaption: modal.querySelector('.loan-fee-caption').textContent,
      };
    }`);
    check('loan modal compares hold, live cash out value, and net loan proceeds',
      loanModal.rows[0][0] === 'Hold' && loanModal.rows[0][1].includes('TEST')
        && (loanModal.rows[0][1].includes('cash out value ~') || loanModal.rows[0][1].includes('cash out value unavailable'))
        && loanModal.rows[1][0] === 'Cash out now'
        && (loanModal.rows[1][1].includes('tokens burned') || loanModal.rows[1][1] === 'Unavailable now')
        && loanModal.rows[2][0] === 'Loan now'
        && (loanModal.rows[2][1].includes('repay to reclaim') || loanModal.rows[2][1].startsWith('Unavailable'))
        && loanModal.note.includes('Personal tax effects are not included'),
      JSON.stringify(loanModal));
    check('loan modal hides its one-option token selector and says a fully prepaid fee never grows',
      loanModal.sourceHidden && loanModal.sourceOptions.length === 1
        && (loanModal.summary.includes('Never grows — fully prepaid') || loanModal.feeCaption.includes('Fully prepaid — no additional cost over time'))
        && !loanModal.summary.includes('after never'),
      JSON.stringify(loanModal));
    await Q(page, '() => { document.querySelector(".modal-close").click(); return 1; }');

    // 2. Create flow opens with all five steps.
    await freshCreateFlow(page, 501);
    const steps = await Q(page, '() => [...document.querySelectorAll(".create-step-label")].map(s=>s.textContent.trim())');
    check('create flow shows 5 steps (Flavor/Basics/Rulesets/Shop/Deploy)',
      steps.length === 5 && steps.includes('Flavor') && steps.includes('Basics') && steps.includes('Deploy'), JSON.stringify(steps));

    // 2b. One import action owns the .jb input path; there is no competing paste-JSON affordance.
    const ioActions = await Q(page, '() => [...document.querySelectorAll(".create-head button")].map(b=>b.textContent.trim().toLowerCase())');
    check('create flow exposes one .jb import action without paste JSON', ioActions.includes('import') && !ioActions.includes('paste json'), JSON.stringify(ioActions));

    // 3. Accounting offers ETH / USDC / Custom; custom is exclusive.
    const pills = await Q(page, '() => [...document.querySelectorAll(".create-pill")].map(p=>p.textContent.trim())');
    check('accounting offers ETH/USDC/Custom token pills', ['ETH', 'USDC', 'Custom token'].every(x => pills.includes(x)), JSON.stringify(pills));
    await Q(page, '() => { [...document.querySelectorAll(".create-pill")].find(p=>p.textContent.trim()==="Custom token").click(); return 1; }');
    await page.waitForTimeout(400);
    const customExclusive = await Q(page, '() => { const sel=[...document.querySelectorAll(".create-pill.selected")].map(p=>p.textContent.trim()); const addr=[...document.querySelectorAll(".create-step input")].some(i=>/ERC-20 token address/.test(i.placeholder||"")); return { sel, addr }; }');
    check('selecting Custom is exclusive + shows the token-address field', customExclusive.sel.length === 1 && customExclusive.sel[0] === 'Custom token' && customExclusive.addr, JSON.stringify(customExclusive));

    // 4. Revnet accounting is multi-select (ETH + USDC).
    await freshCreateFlow(page, 503);
    await Q(page, '() => { const s=document.querySelector(".create-step select"); s.value="revnet"; s.dispatchEvent(new Event("change",{bubbles:true})); return 1; }');
    await page.waitForTimeout(600);
    await Q(page, '() => { [...document.querySelectorAll(".create-pill")].find(p=>p.textContent.trim()==="USDC").click(); return 1; }');
    await page.waitForTimeout(400);
    const revMulti = await Q(page, '() => [...document.querySelectorAll(".create-pill.selected")].map(p=>p.textContent.trim())');
    check('revnet accounting is multi-select (ETH+USDC)', revMulti.includes('ETH') && revMulti.includes('USDC'), JSON.stringify(revMulti));

    // 5. Deploy step spells out the disabled reasons for a fresh project.
    await freshCreateFlow(page, 505);
    await Q(page, '() => { const d=[...document.querySelectorAll(".create-step-label")].find(x=>/Deploy/i.test(x.textContent||"")); if(d)d.click(); return 1; }');
    await page.waitForTimeout(1100);
    const deployNotes = await Q(page, '() => { const launch=[...document.querySelectorAll(".create-step button")].find(b=>/^Launch|^Deploy/.test(b.textContent)); const hasExport=[...document.querySelectorAll(".create-step button")].some(b=>b.textContent.trim()==="Export your configuration"); const notes=[...document.querySelectorAll(".create-step .create-hint, .create-step .create-banner")].map(h=>h.textContent.trim()).filter(Boolean); return { disabled: launch?launch.disabled:null, hasExport, hasNameReason: notes.some(n=>/project name/i.test(n)), hasTosReason: notes.some(n=>/box above/i.test(n)) }; }');
    check('deploy launch button disabled with explained reasons + pre-deploy configuration export', deployNotes.disabled === true && deployNotes.hasExport && deployNotes.hasNameReason && deployNotes.hasTosReason, JSON.stringify(deployNotes));

    // 6. Ruleset approval condition: renamed, offers a Custom address shown inline beside the dropdown.
    await freshCreateFlow(page, 507);
    await Q(page, '() => { [...document.querySelectorAll(".create-step-label")].find(s=>/Ruleset/i.test(s.textContent)).click(); return 1; }');
    await page.waitForTimeout(700);
    const approval = await Q(page, '() => { const lbl=[...document.querySelectorAll(".create-label")].some(l=>/Ruleset approval condition/.test(l.textContent)); const sel=[...document.querySelectorAll(".create-step select")].find(s=>[...s.options].some(o=>/Custom address/.test(o.textContent))); return { lbl, hasCustom: !!sel }; }');
    check('ruleset approval condition renamed + offers Custom address', approval.lbl && approval.hasCustom, JSON.stringify(approval));
    await Q(page, '() => { const s=[...document.querySelectorAll(".create-step select")].find(x=>[...x.options].some(o=>/Custom address/.test(o.textContent))); s.value="custom"; s.dispatchEvent(new Event("change",{bubbles:true})); return 1; }');
    await page.waitForTimeout(400);
    const inlineAddr = await Q(page, '() => { const row=document.querySelector(".create-approval-row"); return !!(row && row.querySelector(".create-approval-addr")); }');
    check('custom approval address renders inline beside the dropdown', inlineAddr);

    // 7. Split lock shows only when the ruleset has a fixed duration (hidden for Flexible).
    await Q(page, '() => { [...document.querySelectorAll(".create-stage-head, .create-stage-title")].find(e=>/Ruleset #1/.test(e.textContent)).click(); return 1; }');
    await page.waitForTimeout(500);
    await Q(page, '() => { const d=[...document.querySelectorAll(".create-stage-card select")].find(s=>[...s.options].some(o=>/Flexible/.test(o.textContent))); d.value="2419200"; d.dispatchEvent(new Event("change",{bubbles:true})); return 1; }');
    await page.waitForTimeout(400);
    await Q(page, '() => { const a=[...document.querySelectorAll(".create-stage-card a, .create-stage-card button")].find(e=>/Add split/i.test(e.textContent)); if(a)a.click(); return 1; }');
    await page.waitForTimeout(400);
    const lockShown = await Q(page, '() => document.querySelectorAll(".create-split-lock").length');
    await Q(page, '() => { const d=[...document.querySelectorAll(".create-stage-card select")].find(s=>[...s.options].some(o=>/Flexible/.test(o.textContent))); d.value="0"; d.dispatchEvent(new Event("change",{bubbles:true})); return 1; }');
    await page.waitForTimeout(400);
    const lockHidden = await Q(page, '() => document.querySelectorAll(".create-split-lock").length');
    check('split lock shows for fixed duration, hidden for Flexible', lockShown >= 1 && lockHidden === 0, 'shown=' + lockShown + ' hidden=' + lockHidden);

    // 8. Custom accounting-token project invariants (live Base Sepolia — basesep:13 pays/prices in KMAC only).
    // This is the adversarial fixture for every "assumed ETH-or-USDC" path: header balance symbol, pay-token
    // list gated on routability, shop price symbol, ruleset base-currency label, and the raw currency-id leak.
    await page.goto(BASE + '?r=600#basesep:13', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const fig = document.querySelector('.detail-head-stats .usd-balance-fig');
      return fig && fig.textContent.trim() && fig.textContent.trim() !== '…' && fig.textContent.trim() !== '—';
    }, null, { timeout: 45000 }).catch(() => {});
    const headerBal = await Q(page, '() => (document.querySelector(".detail-head-stats .usd-balance-fig")||{textContent:""}).textContent.trim()');
    check('custom-token header balance shows the symbol, not an address', /KMAC/.test(headerBal) && !/0x/i.test(headerBal), 'fig=' + headerBal);

    // Wait for the REFINED token list (the sync default shows ETH/USDC until accounting contexts resolve).
    // A regression that wrongly offers ETH/USDC still fails below: KMAC would appear alongside them.
    await page.waitForFunction(() => {
      const wrap = document.querySelector('.paybox-curr-wrap');
      return wrap && /KMAC/.test(wrap.textContent);
    }, null, { timeout: 45000 }).catch(() => {});
    const payTokens = await Q(page, `() => {
      const sel = document.querySelector('.paybox-curr-wrap .paybox-select');
      if (sel) return [...sel.options].map(o => o.textContent.trim());
      const stat = document.querySelector('.paybox-curr-wrap .paybox-curr-static');
      return stat ? [stat.textContent.trim()] : [];
    }`);
    check('custom-token pay list offers only routable tokens (KMAC, no ETH/USDC)',
      payTokens.length === 1 && /KMAC/.test(payTokens[0]), JSON.stringify(payTokens));

    await page.waitForFunction(() => document.querySelector('.paybox-shop-price'), null, { timeout: 45000 }).catch(() => {});
    const shopPrice = await Q(page, '() => (document.querySelector(".paybox-shop-price")||{textContent:""}).textContent.trim()');
    check('custom-token shop price shows the symbol, not "currency <id>"', /KMAC/.test(shopPrice) && !/currency \d/.test(shopPrice), 'price=' + shopPrice);

    const idLeak = await Q(page, '() => /currency \\d{6,}/.test(document.body.textContent)');
    check('no raw currency-id string leaks anywhere on the project page', !idLeak);

    await page.goto(BASE + '?r=601#basesep:13/rulesets', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => [...document.querySelectorAll('*')].some(n => n.children.length === 0 && n.textContent.trim() === 'Base currency'), null, { timeout: 45000 }).catch(() => {});
    const baseCur = await Q(page, `() => {
      const key = [...document.querySelectorAll('*')].find(n => n.children.length === 0 && n.textContent.trim() === 'Base currency');
      const row = key && key.parentElement ? key.parentElement.textContent : '';
      const issuanceKey = [...document.querySelectorAll('*')].find(n => n.children.length === 0 && n.textContent.trim() === 'Total issuance rate');
      const issuance = issuanceKey && issuanceKey.parentElement ? issuanceKey.parentElement.textContent : '';
      return { row, issuance };
    }`);
    check('ruleset base currency labels the real currency (KMAC, not ETH)',
      /KMAC/.test(baseCur.row) && !/ETH/.test(baseCur.row) && /\/ KMAC/.test(baseCur.issuance), JSON.stringify(baseCur));

  } catch (e) {
    check('smoke run completed without throwing', false, (e.message || String(e)).split('\n')[0]);
  } finally {
    // Never close a user-owned browser reached over CDP. Process exit disconnects this client without touching it.
    if (isolated) await browser.close();
    if (staticServer) await new Promise((resolve) => staticServer.close(resolve));
  }

  console.log('\n' + results.join('\n'));
  console.log('\nUI smoke: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL ' + (e.message || e)); process.exit(1); });
