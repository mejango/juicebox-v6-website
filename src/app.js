// src/app.js
// Entry point: tabs, wallet, directory rendering
// Chain selection is per-function-form, not global.

import { erc20Abi, formatUnits } from 'viem';
import { contracts, meta, natspec, categories, chains, commonActions, getFunctions, getAddress, getFunctionSource, getGithubUrl } from './abi-registry.js';
import { renderFunctionForm } from './form.js';
import { getAuditPrompt, getComponentAuditPrompt } from './prompts.js';
import { renderStyleEditor } from './components.js';
import { buildEmbedUrl, getAccount, getWalletClient, createPublicClientForChain, connect, disconnect, onWalletChange, eagerConnect, truncAddr, getProviders, refreshProviders, errMessage, initSafeApp } from './component-base.js';
import { renderLearnTab, renderBuildTab, renderWhyTab } from './learn-build.js';
import { renderDiscoverTab, applyDiscoverRoute, cancelDiscoverRoute, renderAdminTab, classifyAccountQuery, ensAddressOf, activeProjectForWallet } from './discover.js';
import { getViewAs, setViewAs, clearViewAs, onViewAsChange } from './view-as.js';
import { renderDataTab } from './data-tab.js';
import { mountFontSelector, applySavedFont } from './font-selector.js';
import { isMobileDevice, mobileWalletLinks, walletDappUrl } from './wallet-links.js';
import { reverseEns } from './create-flow.js';
import { renderAccountView } from './account-view.js';
import { CHAINS, getChainTokens } from './chain.js';

// Component renderers for pretty mode
import { renderPayComponent } from './pay-component.js';
import { renderCashOutComponent } from './cashout-component.js';
import { renderPayoutsComponent } from './payouts-component.js';
import { renderMintComponent } from './mint-component.js';
import { renderReservedComponent } from './reserved-component.js';
import { renderDeployERC20Component } from './deploy-erc20-component.js';
import { renderBurnComponent } from './burn-component.js';
import { renderLaunchComponent } from './launch-component.js';
import { renderQueueRulesetComponent } from './queue-ruleset-component.js';
import { renderPermissionsComponent } from './permissions-component.js';

function redirectBlockingPathGateway() {
  if (location.hostname !== 'gateway.pinata.cloud') return false;
  var match = /^\/ipfs\/([^/?#]+)(\/.*)?$/.exec(location.pathname);
  if (!match) return false;
  var cid = match[1];
  var rest = match[2] || '/';
  location.replace('https://ipfs.io/ipfs/' + cid + rest + location.search + location.hash);
  return true;
}

var REDIRECTING_FROM_BLOCKING_GATEWAY = redirectBlockingPathGateway();

// Hash fragments never reach link-preview crawlers. Mirror a project route in
// the query string so a copied URL remains static-IPFS compatible in browsers
// while an HTTP host can render project-specific Open Graph metadata.
function projectRouteFromHash() {
  var raw = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  return /^([a-z]+|\d+):[1-9]\d*$/i.test(raw) || /^@[^/?#]+$/u.test(raw) ? raw : null;
}

function restoreProjectHashFromQuery() {
  if (location.hash) return;
  try {
    var route = new URL(location.href).searchParams.get('project');
    if (!(/^([a-z]+|\d+):[1-9]\d*$/i.test(route || '') || /^@[^/?#]+$/u.test(route || ''))) return;
    history.replaceState(null, '', location.pathname + location.search + '#' + route);
  } catch (_) {}
}

function syncProjectPreviewQuery() {
  try {
    var url = new URL(location.href);
    var route = projectRouteFromHash();
    if (route) url.searchParams.set('project', route);
    else url.searchParams.delete('project');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch (_) {}
}

function currentIpfsCid() {
  var pathMatch = /^\/ipfs\/([^/?#]+)/.exec(location.pathname);
  if (pathMatch) return pathMatch[1];

  var labels = location.hostname.split('.');
  var ipfsIndex = labels.indexOf('ipfs');
  if (ipfsIndex > 0) return labels.slice(0, ipfsIndex).join('.');

  return '';
}

function updateFooterIpfsCid() {
  var el = document.getElementById('ipfs-cid-meta');
  var cid = currentIpfsCid();
  if (el && cid) el.textContent = 'ipfs: ' + cid;
}

// Map contract.function to pretty component renderer
var PRETTY_COMPONENTS = {
  'JBMultiTerminal.pay': renderPayComponent,
  'JBMultiTerminal.cashOutTokensOf': renderCashOutComponent,
  'JBMultiTerminal.sendPayoutsOf': renderPayoutsComponent,
  'JBController.mintTokensOf': renderMintComponent,
  'JBController.sendReservedTokensToSplitsOf': renderReservedComponent,
  'JBController.deployERC20For': renderDeployERC20Component,
  'JBController.burnTokensOf': renderBurnComponent,
  'JBController.launchProjectFor': renderLaunchComponent,
  'JBController.queueRulesetsOf': renderQueueRulesetComponent,
  'JBOmnichainDeployer.launchProjectFor': renderLaunchComponent,
  'JBPermissions.setPermissionsFor': renderPermissionsComponent,
};

// --- Tab switching ---

// URL nav-name <-> data-tab id mapping (the hash uses friendly names).
var NAV_TO_TAB = { discover: 'discover', actions: 'common', learn: 'learn', build: 'build', api: 'directory', data: 'data', admin: 'admin', why: 'why', account: 'account' };
var TAB_TO_NAV = { discover: 'discover', common: 'actions', learn: 'learn', build: 'build', directory: 'api', data: 'data', admin: 'admin', why: 'why' };

function activateNavTab(dataTab) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
  var btn = document.querySelector('.tab[data-tab="' + dataTab + '"]');
  if (btn) btn.classList.add('active');
  var content = document.getElementById('tab-' + dataTab);
  if (content) content.classList.add('active');
}

function initTabs() {
  document.querySelectorAll('.tab').forEach(function(btn) {
    btn.addEventListener('click', function() {
      // Update the hash; the hashchange handler applies the route (keeps URL and UI in sync).
      location.hash = '#' + (TAB_TO_NAV[btn.dataset.tab] || btn.dataset.tab);
    });
  });
  // The Create button now lives inside the Discover tab (rendered by renderDiscoverTab), wired there.

  var connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    var connecting = false;
    var updateConnect = function() {
      var acc = getAccount();
      var viewed = getViewAs();
      var display = viewed || acc;
      connectBtn.textContent = viewed
        ? 'Viewing as ' + truncAddr(viewed)
        : acc
          ? truncAddr(acc)
          : (connecting ? 'Connecting…' : 'Connect wallet');
      connectBtn.classList.toggle('connected', !!acc && !viewed);
      connectBtn.classList.toggle('viewing-as', !!viewed);
      connectBtn.title = display || 'Connect a wallet or view as another account';
      // Show the primary ENS name when the displayed account has one.
      if (display) {
        reverseEns(display).then(function (name) {
          var currentViewed = getViewAs();
          var currentDisplay = currentViewed || getAccount();
          if (name && currentDisplay === display) {
            connectBtn.textContent = currentViewed ? 'Viewing as ' + name : name;
          }
        });
      }
    };
    updateConnect();
    onWalletChange(updateConnect);
    onViewAsChange(updateConnect);

    // The same trigger owns wallet connection and view-as state.
    var walletMenu = null;
    function closeWalletMenu() { if (walletMenu) { walletMenu.remove(); walletMenu = null; document.removeEventListener('click', onDocClick, true); } }
    function onDocClick(e) { if (walletMenu && e.target !== connectBtn && !walletMenu.contains(e.target)) closeWalletMenu(); }
    function positionWalletMenu(anchor) {
      var r = (anchor || connectBtn).getBoundingClientRect();
      walletMenu.style.top = (r.bottom + 6) + 'px';
      walletMenu.style.right = Math.max(8, window.innerWidth - r.right) + 'px';
    }
    function openWalletNotice(message, kind) {
      closeWalletMenu();
      walletMenu = document.createElement('div');
      walletMenu.className = 'wallet-menu';
      positionWalletMenu();
      var note = document.createElement('div');
      note.className = 'wallet-menu-note' + (kind ? ' ' + kind : '');
      note.textContent = message;
      walletMenu.appendChild(note);
      if (!getProviders().length) {
        mobileWalletLinks(location.href).forEach(function (l) {
          var a = document.createElement('a');
          a.className = 'wallet-menu-item wallet-menu-link';
          a.href = l.href;
          a.textContent = l.name;
          walletMenu.appendChild(a);
        });
        // iOS wallet apps can register an "Open in…" share action. This reaches Rainbow and other installed
        // wallets without adding a connection SDK or depending on undocumented app-specific URL schemes.
        if (typeof navigator.share === 'function') {
          var share = document.createElement('button');
          share.type = 'button';
          share.className = 'wallet-menu-item';
          share.textContent = 'Open another wallet…';
          share.addEventListener('click', function () {
            try {
              navigator.share({ title: document.title, url: walletDappUrl(location.href) }).catch(function (err) {
                if (!err || err.name !== 'AbortError') openWalletNotice(errMessage(err, 'Could not open wallet apps.'), 'wallet-menu-error');
              });
            } catch (err) {
              openWalletNotice(errMessage(err, 'Could not open wallet apps.'), 'wallet-menu-error');
            }
          });
          walletMenu.appendChild(share);
        }
      }
      appendViewAsItem(walletMenu);
      document.body.appendChild(walletMenu);
      setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
    }
    function connectToProvider(provider) {
      closeWalletMenu();
      connecting = true;
      connectBtn.disabled = true;
      updateConnect();
      connect(provider).then(function () {
        closeWalletMenu();
      }).catch(function (err) {
        openWalletNotice(errMessage(err, 'Could not connect wallet.'), 'wallet-menu-error');
      }).finally(function () {
        connecting = false;
        connectBtn.disabled = false;
        updateConnect();
      });
    }
    // Inline "View as" prompt (address or ENS) appended inside a wallet-menu dropdown.
    function appendViewAsPrompt(menu) {
      var wrap = document.createElement('div');
      wrap.className = 'viewas-prompt';
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'viewas-input';
      input.placeholder = '0x address or ENS name';
      var go = document.createElement('button'); go.type = 'button'; go.className = 'viewas-go'; go.textContent = 'View';
      var err = document.createElement('div'); err.className = 'viewas-err';
      function submit() {
        var q = classifyAccountQuery(input.value);
        if (q.kind === 'address') { setViewAs(q.address); closeWalletMenu(); return; }
        if (q.kind === 'ens') {
          go.disabled = true;
          err.textContent = 'Resolving ' + q.name + '…';
          ensAddressOf(q.name).then(function (resolved) {
            go.disabled = false;
            if (!resolved) { err.textContent = 'Could not resolve ' + q.name + '.'; return; }
            setViewAs(resolved);
            closeWalletMenu();
          });
          return;
        }
        err.textContent = 'Enter a 0x address or an ENS name.';
      }
      go.addEventListener('click', submit);
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
      wrap.appendChild(input); wrap.appendChild(go); wrap.appendChild(err);
      menu.appendChild(wrap);
      return input;
    }
    // "View as…" menu item that expands the inline prompt in place (one per menu).
    function appendViewAsItem(menu) {
      var separator = document.createElement('div');
      separator.className = 'wallet-menu-separator';
      separator.setAttribute('aria-hidden', 'true');
      menu.appendChild(separator);
      var item = document.createElement('button');
      item.className = 'wallet-menu-item';
      item.textContent = getViewAs() ? 'View as another account…' : 'View as…';
      item.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menu.querySelector('.viewas-prompt')) return;
        var input = appendViewAsPrompt(menu);
        input.focus();
      });
      menu.appendChild(item);
    }
    function formatMenuBalance(value, decimals, symbol) {
      var amount = Number(formatUnits(BigInt(value || 0n), Number(decimals)));
      return amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) + ' ' + symbol;
    }
    var totalBalanceOfAbi = [{
      type: 'function', name: 'totalBalanceOf', stateMutability: 'view',
      inputs: [{ name: 'holder', type: 'address' }, { name: 'projectId', type: 'uint256' }],
      outputs: [{ name: '', type: 'uint256' }],
    }];
    function appendWalletBalances(menu, account) {
      var panel = document.createElement('div');
      panel.className = 'wallet-menu-balances';
      panel.textContent = 'Loading balances…';
      menu.appendChild(panel);

      var activeProject = activeProjectForWallet();
      var chainPromise = activeProject
        ? Promise.resolve(activeProject.chains)
        : Promise.resolve(getWalletClient()).then(function (wallet) {
          return wallet && wallet.getChainId ? wallet.getChainId().then(function (chainId) { return [{ chainId: chainId, projectId: null }]; }) : [];
        });
      chainPromise.then(function (projectChains) {
        if (!panel.isConnected) return;
        // Returning here without touching the panel left "Loading balances…" spinning forever
        // — the state View-as lands in when no wallet is connected outside a project page.
        if (!projectChains || !projectChains.length) {
          panel.textContent = 'No chains to read balances on.';
          return;
        }
        return Promise.all(projectChains.map(function (projectChain) {
          var chainId = Number(projectChain.chainId);
          if (!CHAINS[chainId]) throw new Error('Unsupported chain ' + chainId);
          var client = createPublicClientForChain(chainId);
          var nativeSymbol = CHAINS[chainId].nativeCurrency && CHAINS[chainId].nativeCurrency.symbol || 'ETH';
          var usdc = getChainTokens(chainId).find(function (token) { return String(token.symbol || '').toUpperCase() === 'USDC'; });
          var nativeRead = client.getBalance({ address: account })
            .then(function (value) { return { ok: true, value: value, symbol: nativeSymbol }; })
            .catch(function () { return { ok: false, value: 0n, symbol: nativeSymbol }; });
          var usdcRead = usdc
            ? client.readContract({ address: usdc.address, abi: erc20Abi, functionName: 'balanceOf', args: [account] })
              .then(function (value) { return { ok: true, value: value, decimals: usdc.decimals }; })
              .catch(function () { return { ok: false, value: 0n, decimals: usdc.decimals }; })
            : Promise.resolve({ ok: false, value: 0n, decimals: 6 });
          var projectRead = activeProject
            ? client.readContract({
              address: getAddress('JBTokens', chainId),
              abi: totalBalanceOfAbi,
              functionName: 'totalBalanceOf',
              args: [account, BigInt(projectChain.projectId)],
            }).then(function (value) { return { ok: true, value: value }; })
              .catch(function () { return { ok: false, value: 0n }; })
            : Promise.resolve(null);
          return Promise.all([nativeRead, usdcRead, projectRead]);
        })).then(function (chainRows) {
          if (!panel.isConnected) return;
          panel.innerHTML = '';
          var chain = document.createElement('div');
          chain.className = 'wallet-menu-balance-chain';
          chain.textContent = activeProject
            ? 'Across ' + projectChains.length + ' project chains'
            : (CHAINS[projectChains[0].chainId].name || ('Chain ' + projectChains[0].chainId));
          panel.appendChild(chain);
          var native = chainRows.map(function (row) { return row[0]; });
          var usdcs = chainRows.map(function (row) { return row[1]; });
          var projects = chainRows.map(function (row) { return row[2]; }).filter(Boolean);
          var nativeSymbol = native[0] && native[0].symbol || 'ETH';
          var rows = [
            {
              label: nativeSymbol,
              value: native.every(function (row) { return row.ok; })
                ? formatMenuBalance(native.reduce(function (sum, row) { return sum + row.value; }, 0n), 18, nativeSymbol)
                : 'Unavailable',
            },
            {
              label: 'USDC',
              value: usdcs.every(function (row) { return row.ok; })
                ? formatMenuBalance(usdcs.reduce(function (sum, row) { return sum + row.value; }, 0n), 6, 'USDC')
                : 'Unavailable',
            },
          ];
          if (activeProject) {
            var projectSymbol = activeProject.tokenSymbol || 'Project token';
            rows.push({
              label: projectSymbol,
              value: projects.length === projectChains.length && projects.every(function (row) { return row.ok; })
                ? formatMenuBalance(projects.reduce(function (sum, row) { return sum + row.value; }, 0n), 18, projectSymbol)
                : 'Unavailable',
            });
          }
          rows.forEach(function (row) {
            var line = document.createElement('div');
            line.className = 'wallet-menu-balance-row';
            var label = document.createElement('span'); label.textContent = row.label;
            var value = document.createElement('strong'); value.textContent = row.value;
            line.appendChild(label); line.appendChild(value); panel.appendChild(line);
          });
        });
      }).catch(function () { if (panel.isConnected) panel.textContent = 'Balances unavailable'; });
    }
    function openWalletMenu() {
      closeWalletMenu();
      var acc = getAccount();
      var viewed = getViewAs();
      walletMenu = document.createElement('div');
      walletMenu.className = 'wallet-menu';
      positionWalletMenu();
      if (viewed || acc) appendWalletBalances(walletMenu, viewed || acc);
      var acctItem = document.createElement('button'); acctItem.className = 'wallet-menu-item'; acctItem.textContent = 'Account';
      // While "View as" is active the Account item targets the impersonated address.
      acctItem.addEventListener('click', function () { closeWalletMenu(); location.hash = '#account/' + (getViewAs() || acc); });
      walletMenu.appendChild(acctItem);
      if (viewed) {
        var normal = document.createElement('button');
        normal.className = 'wallet-menu-item';
        normal.textContent = acc ? 'View as connected wallet' : 'Exit View as';
        normal.addEventListener('click', function () { closeWalletMenu(); clearViewAs(); });
        walletMenu.appendChild(normal);
        appendViewAsItem(walletMenu);
        document.body.appendChild(walletMenu);
        setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
        return;
      }
      var copy = document.createElement('button'); copy.className = 'wallet-menu-item'; copy.textContent = 'Copy address';
      copy.addEventListener('click', function () { try { navigator.clipboard.writeText(acc); } catch (_) {} closeWalletMenu(); });
      var disc = document.createElement('button'); disc.className = 'wallet-menu-item wallet-menu-danger'; disc.textContent = 'Disconnect';
      disc.addEventListener('click', function () { closeWalletMenu(); disconnect().catch(function () {}); });
      walletMenu.appendChild(copy);
      walletMenu.appendChild(disc);
      appendViewAsItem(walletMenu);
      document.body.appendChild(walletMenu);
      setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
    }
    // When not connected, show detected wallets and View as… in one dropdown.
    function openWalletPicker() {
      closeWalletMenu();
      var providers = getProviders();
      if (!providers.length) {
        var mobile = isMobileDevice(typeof navigator !== 'undefined' ? navigator : null);
        openWalletNotice(mobile ? 'Checking this browser for wallet access…' : 'Looking for wallet…', '');
        // MetaMask Mobile may not inject `window.ethereum` until after the
        // page lifecycle has started. Its documented initialization window is
        // up to three seconds; refreshProviders also resolves early when the
        // provider event arrives.
        refreshProviders(mobile ? 3000 : 500).then(function (fresh) {
          if (getAccount() || !walletMenu) return;
          if (fresh.length) { openWalletPicker(); return; }
          if (mobile) openWalletNotice('Choose a wallet app to continue. This page will reopen there.', '');
          else openWalletNotice('No wallet detected in this browser. Open this site in a wallet app browser, or install a browser wallet.', 'wallet-menu-error');
        });
        return;
      }
      walletMenu = document.createElement('div');
      walletMenu.className = 'wallet-menu';
      positionWalletMenu();
      providers.forEach(function (p) {
        var item = document.createElement('button'); item.className = 'wallet-menu-item wallet-pick';
        if (p.info && p.info.icon) {
          var img = document.createElement('img'); img.className = 'wallet-pick-icon'; img.src = p.info.icon; img.alt = ''; item.appendChild(img);
        }
        var nm = document.createElement('span'); nm.textContent = (p.info && p.info.name) || 'Wallet'; item.appendChild(nm);
        item.addEventListener('click', function () { connectToProvider(p); });
        walletMenu.appendChild(item);
      });
      appendViewAsItem(walletMenu);
      document.body.appendChild(walletMenu);
      setTimeout(function () { document.addEventListener('click', onDocClick, true); }, 0);
    }
    connectBtn.addEventListener('click', function () {
      if (walletMenu) { closeWalletMenu(); return; }
      if (getViewAs() || getAccount()) { openWalletMenu(); return; }
      openWalletPicker();
    });
  }
  // If the site is opened as a Safe App (inside Safe{Wallet}), auto-connect the Safe; otherwise restore a
  // prior wallet connection silently so a refresh keeps the user connected.
  initSafeApp().then(function (safe) { if (!safe) eagerConnect(); });
}

// Parse the hash and apply it: pick the nav tab, and (for discover) open the project route.
function applyHash() {
  var raw = (location.hash || '').replace(/^#\/?/, '');
  var nav, projectRoute = null, sectionId = null, accountRoute = null;
  if (raw === '' || raw === 'discover') { nav = 'discover'; }
  else if (/^@/.test(raw)) { nav = 'discover'; projectRoute = raw; } // @<verified-handle>[/tab]
  else if (raw.indexOf(':') !== -1) { nav = 'discover'; projectRoute = raw; } // <slug>:<id>[/tab]
  else if (/^account\//.test(raw)) { nav = 'account'; accountRoute = raw.slice('account/'.length); } // #account/<address-or-ens>[/tab]
  else if (/^(learn|build|why)-/.test(raw)) { nav = raw.split('-')[0]; sectionId = raw; } // guide section deep link
  else { nav = raw.split('/')[0]; }
  var activeTab = NAV_TO_TAB[nav] || 'discover';
  if (activeTab !== 'discover') cancelDiscoverRoute();
  activateNavTab(activeTab);
  if (accountRoute != null) renderAccountView(accountRoute);
  else if (activeTab === 'discover') applyDiscoverRoute(projectRoute);
  // Scroll to a deep-linked guide section once the tab's content has rendered (copy-link buttons emit these).
  else if (sectionId) setTimeout(function () { var t = document.getElementById(sectionId); if (t) t.scrollIntoView({ block: 'start' }); }, 60);
}

function onHashChange() {
  syncProjectPreviewQuery();
  // Programmatic hash updates (card open, detail tab, back-to-grid) set this flag so we don't re-render.
  if (window.__suppressHash) { window.__suppressHash = false; return; }
  applyHash();
}

function onPageShow(event) {
  // A BFCache restore can repaint an old verified alias without firing hashchange. Re-run the full mutable-handle
  // route on persisted restores so ENS, live authority, and JBProjectHandles are checked before that detail stays.
  var raw = (location.hash || '').replace(/^#\/?/, '');
  if (!event || !event.persisted || raw.charAt(0) !== '@') return;
  window.__suppressHash = false;
  syncProjectPreviewQuery();
  applyHash();
}

function initAuditPrompt() {
  var links = document.querySelectorAll('[data-audit-prompt-link], #audit-prompt-link');
  links.forEach(function(link) {
    var defaultLabel = link.textContent;
    link.addEventListener('click', function(e) {
      e.preventDefault();
      var prompt = getAuditPrompt();
      navigator.clipboard.writeText(prompt).then(function() {
        link.textContent = 'COPIED TO CLIPBOARD';
        setTimeout(function() { link.textContent = defaultLabel; }, 2000);
      });
    });
  });
}

// --- Common Actions tab ---

function renderCommonActions() {
  var container = document.getElementById('tab-common');
  container.innerHTML = '';

  var wipBanner = document.createElement('div');
  wipBanner.className = 'discover-header';
  wipBanner.textContent = 'Work in progress';
  container.appendChild(wipBanner);

  for (var i = 0; i < commonActions.length; i++) {
    var section = commonActions[i];
    renderActionSection(container, section.title, section.className, section.entries);
  }
}

function renderActionSection(container, title, className, actions) {
  var header = document.createElement('div');
  header.className = 'section-header ' + className;
  header.textContent = title;
  container.appendChild(header);

  var extraRows = [];
  var moreRows = [];
  for (var i = 0; i < actions.length; i++) {
    var entry = actions[i];
    var fns = getFunctions(entry.contract);
    var fn = findFunction(fns, entry.function);
    if (!fn) continue;
    var getAddr = makeAddrGetter(entry.contract);
    var abi = contracts[entry.contract] || [];
    var prettyKey = entry.contract + '.' + entry.function;
    var prettyRenderer = PRETTY_COMPONENTS[prettyKey] || null;
    var row = renderFunctionRow(fn, entry.contract, getAddr, abi, entry.label, entry.hint, prettyRenderer);
    if (entry.more) {
      row.style.display = 'none';
      moreRows.push(row);
    } else if (entry.extra) {
      row.style.display = 'none';
      extraRows.push(row);
    }
    container.appendChild(row);
  }

  // First toggle: show extra actions
  if (extraRows.length > 0) {
    var toggleRow = document.createElement('div');
    toggleRow.className = 'toggle-row';
    container.appendChild(toggleRow);

    var extraToggle = document.createElement('div');
    extraToggle.className = 'show-more-toggle';
    extraToggle.textContent = '[show ' + extraRows.length + ' more]';
    var extraShown = false;
    toggleRow.appendChild(extraToggle);

    // Second toggle: show even more actions (hidden until extras are shown)
    var moreToggle = null;
    var moreShown = false;
    if (moreRows.length > 0) {
      moreToggle = document.createElement('div');
      moreToggle.className = 'show-more-toggle';
      moreToggle.textContent = '[show ' + moreRows.length + ' more]';
      moreToggle.style.display = 'none';
      toggleRow.appendChild(moreToggle);

      moreToggle.addEventListener('click', function() {
        moreShown = !moreShown;
        for (var m = 0; m < moreRows.length; m++) {
          moreRows[m].style.display = moreShown ? '' : 'none';
        }
        if (moreShown) {
          moreToggle.textContent = '[show fewer]';
          extraToggle.style.display = 'none';
        } else {
          // Collapse everything — extras too
          extraShown = false;
          for (var k = 0; k < extraRows.length; k++) {
            extraRows[k].style.display = 'none';
          }
          moreToggle.style.display = 'none';
          moreToggle.textContent = '[show ' + moreRows.length + ' more]';
          extraToggle.style.display = '';
          extraToggle.textContent = '[show ' + extraRows.length + ' more]';
        }
      });
    }

    extraToggle.addEventListener('click', function() {
      extraShown = !extraShown;
      for (var k = 0; k < extraRows.length; k++) {
        extraRows[k].style.display = extraShown ? '' : 'none';
      }
      if (!extraShown) {
        // Collapse more rows too when hiding extras
        moreShown = false;
        for (var m = 0; m < moreRows.length; m++) {
          moreRows[m].style.display = 'none';
        }
        if (moreToggle) {
          moreToggle.style.display = 'none';
          moreToggle.textContent = '[show ' + moreRows.length + ' more]';
        }
      }
      extraToggle.textContent = extraShown ? '[show fewer]' : '[show ' + extraRows.length + ' more]';
      if (moreToggle) moreToggle.style.display = extraShown ? '' : 'none';
    });
  } else if (moreRows.length > 0) {
    // No extras, but has more rows — single toggle
    var toggle = document.createElement('div');
    toggle.className = 'show-more-toggle';
    toggle.textContent = '[show ' + moreRows.length + ' more]';
    var shown = false;
    toggle.addEventListener('click', function() {
      shown = !shown;
      for (var m = 0; m < moreRows.length; m++) {
        moreRows[m].style.display = shown ? '' : 'none';
      }
      toggle.textContent = shown ? '[show fewer]' : '[show ' + moreRows.length + ' more]';
    });
    container.appendChild(toggle);
  }
}

function makeAddrGetter(contractName) {
  return function(chainId) { return getAddress(contractName, chainId); };
}

function findFunction(fns, name) {
  for (var i = 0; i < fns.length; i++) {
    if (fns[i].name === name) return fns[i];
  }
  return null;
}

// --- Full Directory tab ---

function renderDirectory() {
  var container = document.getElementById('tab-directory');
  container.innerHTML = '';

  var categoryNames = Object.keys(categories);
  for (var c = 0; c < categoryNames.length; c++) {
    var category = categoryNames[c];
    var contractNames = categories[category];
    if (!contractNames || contractNames.length === 0) continue;

    // Category header
    var catHeader = document.createElement('div');
    catHeader.className = 'category-header';
    catHeader.textContent = category.toUpperCase();
    container.appendChild(catHeader);

    // Contract rows
    for (var n = 0; n < contractNames.length; n++) {
      var contractName = contractNames[n];
      var contractSection = renderContractSection(contractName);
      container.appendChild(contractSection);
    }
  }
}

// --- Data tab ---
// renderDataTab is imported from ./data-tab.js

function sortedDeploymentAddresses(addresses) {
  return Object.keys(addresses || {}).sort(function(a, b) {
    return Number(a) - Number(b);
  }).map(function(chainId) {
    return {
      chainId: chainId,
      chainName: (chains[chainId] && chains[chainId].name) || ('Chain ' + chainId),
      address: addresses[chainId],
    };
  }).filter(function(deployment) {
    return !!deployment.address;
  });
}

function makeCopyAddressButton(address, label, title) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'contract-address';
  button.textContent = address;
  button.setAttribute('aria-label', 'Copy ' + label + ' address');
  button.title = title || 'Copy address';
  button.addEventListener('click', function(e) {
    e.stopPropagation();
    if (!navigator.clipboard || !navigator.clipboard.writeText) return;
    navigator.clipboard.writeText(address).then(function() {
      var previousTitle = button.title;
      button.title = 'Copied';
      button.classList.add('copied');
      window.setTimeout(function() {
        button.title = previousTitle;
        button.classList.remove('copied');
      }, 1200);
    }).catch(function() {});
  });
  return button;
}

function renderContractAddresses(contractName, addresses) {
  var deployments = sortedDeploymentAddresses(addresses);
  if (deployments.length === 0) return null;

  var uniqueAddresses = [];
  deployments.forEach(function(deployment) {
    var normalized = deployment.address.toLowerCase();
    if (!uniqueAddresses.some(function(address) { return address.toLowerCase() === normalized; })) {
      uniqueAddresses.push(deployment.address);
    }
  });

  // CREATE2 deployments commonly share one address across every supported chain.
  if (uniqueAddresses.length === 1) {
    return makeCopyAddressButton(
      uniqueAddresses[0],
      contractName,
      'Copy address — ' + deployments.map(function(deployment) { return deployment.chainName; }).join(', ')
    );
  }

  var details = document.createElement('details');
  details.className = 'contract-addresses';
  details.addEventListener('click', function(e) { e.stopPropagation(); });

  var toggle = document.createElement('summary');
  toggle.textContent = '[' + deployments.length + ' chain addresses]';
  toggle.title = 'Show deployed addresses';
  details.appendChild(toggle);

  var list = document.createElement('div');
  list.className = 'contract-address-list';
  deployments.forEach(function(deployment) {
    var row = document.createElement('div');
    row.className = 'contract-address-row';
    var chainLabel = document.createElement('span');
    chainLabel.className = 'contract-address-chain';
    chainLabel.textContent = deployment.chainName;
    row.appendChild(chainLabel);
    row.appendChild(makeCopyAddressButton(
      deployment.address,
      contractName + ' on ' + deployment.chainName,
      'Copy ' + deployment.chainName + ' address'
    ));
    list.appendChild(row);
  });
  details.appendChild(list);
  return details;
}

function renderContractSection(contractName) {
  var section = document.createElement('div');
  section.className = 'contract-section';

  var fns = getFunctions(contractName);
  var contractMeta = meta[contractName];
  var isSingleton = contractMeta ? contractMeta.singleton : true;

  // Contract summary row (collapsed)
  var summary = document.createElement('div');
  summary.className = 'contract-summary';
  var arrow = document.createElement('span');
  arrow.className = 'fn-arrow';
  arrow.textContent = '\u25B8'; // ▸
  var nameSpan = document.createElement('span');
  nameSpan.className = 'contract-name';
  nameSpan.textContent = contractName;
  var countSpan = document.createElement('span');
  countSpan.className = 'contract-fn-count';
  countSpan.textContent = '(' + fns.length + ' functions)';
  if (!isSingleton) {
    var perProject = document.createElement('span');
    perProject.className = 'per-project-hint';
    perProject.textContent = ' [per-project]';
    countSpan.appendChild(perProject);
  }
  summary.appendChild(arrow);
  summary.appendChild(nameSpan);
  summary.appendChild(countSpan);

  var addressDisplay = renderContractAddresses(contractName, contractMeta && contractMeta.addresses);
  if (addressDisplay) summary.appendChild(addressDisplay);

  // GitHub source link (contract-level)
  var ghUrl = getGithubUrl(contractName);
  if (ghUrl) {
    var ghLink = document.createElement('a');
    ghLink.className = 'contract-source-link';
    ghLink.href = ghUrl;
    ghLink.target = '_blank';
    ghLink.rel = 'noopener';
    ghLink.textContent = '[source ↗]';
    ghLink.addEventListener('click', function(e) { e.stopPropagation(); });
    summary.appendChild(ghLink);
  }

  var expanded = false;
  var contentEl = null;

  // Show contract-level natspec notice below the summary row
  var noticeRow = null;
  if (contractMeta && contractMeta.notice) {
    noticeRow = document.createElement('div');
    noticeRow.className = 'contract-notice';
    noticeRow.textContent = contractMeta.notice;
  }

  summary.addEventListener('click', function() {
    expanded = !expanded;
    arrow.textContent = expanded ? '\u25BE' : '\u25B8'; // ▾ or ▸
    if (expanded && !contentEl) {
      contentEl = document.createElement('div');
      contentEl.className = 'contract-content';

      // Per-project address input
      var addressOverride = null;
      if (!isSingleton) {
        var addrGroup = document.createElement('div');
        addrGroup.className = 'address-override';
        var addrLabel = document.createElement('label');
        addrLabel.className = 'input-label';
        addrLabel.innerHTML = 'contract address <span class="type-hint">required — this contract is deployed per-project</span>';
        addrGroup.appendChild(addrLabel);
        var addrInput = document.createElement('input');
        addrInput.type = 'text';
        addrInput.className = 'field';
        addrInput.placeholder = '0x... paste your deployment address';
        addrGroup.appendChild(addrInput);
        contentEl.appendChild(addrGroup);
        addressOverride = addrInput;
      }

      var abi = contracts[contractName] || [];

      // Function rows
      for (var i = 0; i < fns.length; i++) {
        (function(fn) {
          var getAddr = function(chainId) {
            if (addressOverride && addressOverride.value.trim()) return addressOverride.value.trim();
            return getAddress(contractName, chainId);
          };
          var row = renderFunctionRowLazy(fn, contractName, getAddr, abi);
          contentEl.appendChild(row);
        })(fns[i]);
      }

      section.appendChild(contentEl);
    } else if (contentEl) {
      contentEl.style.display = expanded ? '' : 'none';
    }
  });

  section.appendChild(summary);
  if (noticeRow) section.appendChild(noticeRow);
  return section;
}

// --- Shared: collapsible function row ---

function renderFunctionRow(fn, contractName, getContractAddr, abi, label, hint, prettyRenderer) {
  var row = document.createElement('div');
  row.className = 'fn-row';

  var isRead = fn.stateMutability === 'view' || fn.stateMutability === 'pure';
  var isPayable = fn.stateMutability === 'payable';

  // Collapsed header
  var summary = document.createElement('div');
  summary.className = 'fn-summary';
  var arrowEl = document.createElement('span');
  arrowEl.className = 'fn-arrow';
  arrowEl.textContent = '\u25B8';
  var nameEl = document.createElement('span');
  nameEl.className = 'fn-name-preview ' + (isRead ? 'read' : 'write');
  nameEl.textContent = label || fn.name;
  var contractHint = document.createElement('span');
  contractHint.className = 'fn-contract-hint';
  contractHint.textContent = contractName;

  summary.appendChild(arrowEl);
  summary.appendChild(nameEl);
  if (isPayable) {
    var payBadge = document.createElement('span');
    payBadge.className = 'badge payable';
    payBadge.textContent = 'PAYABLE';
    summary.appendChild(payBadge);
  }
  summary.appendChild(contractHint);
  if (hint) {
    var hintEl = document.createElement('span');
    hintEl.className = 'fn-hint';
    hintEl.textContent = hint;
    summary.appendChild(hintEl);
  }

  var expanded = false;
  var contentEl = null;

  summary.addEventListener('click', function() {
    expanded = !expanded;
    arrowEl.textContent = expanded ? '\u25BE' : '\u25B8';
    if (expanded && !contentEl) {
      contentEl = document.createElement('div');
      contentEl.style.padding = '0 12px 12px';

      if (prettyRenderer) {
        // Toolbar: pretty/raw + [style] + [embed] + [ask your LLM]
        var selectorWrap = document.createElement('div');
        selectorWrap.className = 'fn-view-selector';

        var componentEl = prettyRenderer();
        var compPrefix = componentEl._compPrefix || '';
        var compGetEmbedParams = componentEl._compGetEmbedParams || null;

        var viewSelect = document.createElement('select');
        viewSelect.className = 'fn-view-dropdown';
        var prettyOpt = document.createElement('option');
        prettyOpt.value = 'pretty';
        prettyOpt.textContent = 'pretty';
        viewSelect.appendChild(prettyOpt);
        var rawOpt = document.createElement('option');
        rawOpt.value = 'raw';
        rawOpt.textContent = 'raw';
        viewSelect.appendChild(rawOpt);
        selectorWrap.appendChild(viewSelect);

        // Style toggle next to pretty/raw dropdown
        var styleToggle = document.createElement('button');
        styleToggle.type = 'button';
        styleToggle.className = 'style-toggle-btn';
        styleToggle.textContent = '[style]';
        selectorWrap.appendChild(styleToggle);

        if (compGetEmbedParams) {
          var copyEmbedBtn = document.createElement('button');
          copyEmbedBtn.type = 'button';
          copyEmbedBtn.className = 'style-toggle-btn';
          copyEmbedBtn.textContent = '[embed]';
          copyEmbedBtn.addEventListener('click', function(e) {
            e.preventDefault();
            var src = buildEmbedUrl(compPrefix, compGetEmbedParams());
            var snippet = '<iframe src="' + src + '" width="540" height="600" frameborder="0"></iframe>';
            navigator.clipboard.writeText(snippet).then(function() {
              copyEmbedBtn.textContent = '[copied]';
              setTimeout(function() { copyEmbedBtn.textContent = '[embed]'; }, 1500);
            });
          });
          selectorWrap.appendChild(copyEmbedBtn);
        }

        var copyPromptLink = document.createElement('button');
        copyPromptLink.type = 'button';
        copyPromptLink.className = 'fn-copy-prompt';
        copyPromptLink.textContent = '[ask your LLM]';
        copyPromptLink.addEventListener('click', function(e) {
          e.preventDefault();
          var fnNs = natspec[contractName] ? natspec[contractName][fn.name] : null;
          var prompt = getComponentAuditPrompt(fn, contractName, fnNs, componentEl);
          navigator.clipboard.writeText(prompt).then(function() {
            copyPromptLink.textContent = '[copied]';
            setTimeout(function() { copyPromptLink.textContent = '[ask your LLM]'; }, 2000);
          });
        });
        selectorWrap.appendChild(copyPromptLink);

        contentEl.appendChild(selectorWrap);

        // Inline style editor panel (above component, hidden by default)
        var stylePanel = null;
        var styleVisible = false;
        var styleInlineWrap = document.createElement('div');
        styleInlineWrap.className = 'style-inline-wrap';
        styleInlineWrap.style.display = 'none';
        contentEl.appendChild(styleInlineWrap);

        var prettyContent = document.createElement('div');
        prettyContent.className = 'pretty-content-wrap';
        prettyContent.appendChild(componentEl);
        contentEl.appendChild(prettyContent);

        styleToggle.addEventListener('click', function(e) {
          e.preventDefault();
          styleVisible = !styleVisible;
          if (styleVisible && !stylePanel) {
            stylePanel = renderStyleEditor(prettyContent, function() {
              styleVisible = false;
              styleInlineWrap.style.display = 'none';
              styleToggle.textContent = '[style]';
            });
            stylePanel.className = 'style-editor-inline';
            styleInlineWrap.appendChild(stylePanel);
          }
          styleInlineWrap.style.display = styleVisible ? '' : 'none';
          styleToggle.textContent = styleVisible ? '[hide style]' : '[style]';
        });

        var rawContent = document.createElement('div');
        rawContent.style.display = 'none';
        var rawForm = null;
        contentEl.appendChild(rawContent);

        viewSelect.addEventListener('change', function() {
          if (viewSelect.value === 'pretty') {
            prettyContent.style.display = '';
            rawContent.style.display = 'none';
            styleToggle.style.display = '';
            if (styleVisible) styleInlineWrap.style.display = '';
          } else {
            prettyContent.style.display = 'none';
            rawContent.style.display = '';
            styleToggle.style.display = 'none';
            styleInlineWrap.style.display = 'none';
            if (!rawForm) {
              var fnNatspec = natspec[contractName] ? natspec[contractName][fn.name] : null;
              rawForm = renderFunctionForm(fn, contractName, getContractAddr, abi, fnNatspec);
              rawContent.appendChild(rawForm);
            }
          }
        });
      } else {
        // No component — just render raw form directly
        var fnNatspec = natspec[contractName] ? natspec[contractName][fn.name] : null;
        var formEl = renderFunctionForm(fn, contractName, getContractAddr, abi, fnNatspec);
        contentEl.appendChild(formEl);
      }

      row.appendChild(contentEl);
    } else if (contentEl) {
      contentEl.style.display = expanded ? '' : 'none';
    }
  });

  row.appendChild(summary);
  return row;
}

function renderFunctionRowLazy(fn, contractName, getContractAddr, abi) {
  var row = document.createElement('div');
  row.className = 'fn-row';

  var isRead = fn.stateMutability === 'view' || fn.stateMutability === 'pure';
  var isPayable = fn.stateMutability === 'payable';

  var summary = document.createElement('div');
  summary.className = 'fn-summary';
  var arrowEl = document.createElement('span');
  arrowEl.className = 'fn-arrow';
  arrowEl.textContent = '\u25B8';
  var nameEl = document.createElement('span');
  nameEl.className = 'fn-name-preview ' + (isRead ? 'read' : 'write');
  nameEl.textContent = fn.name;
  var contractHint = document.createElement('span');
  contractHint.className = 'fn-contract-hint';
  contractHint.textContent = contractName;

  summary.appendChild(arrowEl);
  summary.appendChild(nameEl);
  if (isPayable) {
    var payBadge = document.createElement('span');
    payBadge.className = 'badge payable';
    payBadge.textContent = 'PAYABLE';
    summary.appendChild(payBadge);
  }

  // Source link (per-function) \u2014 kept inline with the function name.
  var fnGhUrl = getGithubUrl(contractName, fn);
  if (fnGhUrl) {
    var fnGhLink = document.createElement('a');
    fnGhLink.className = 'fn-source-link';
    fnGhLink.href = fnGhUrl;
    fnGhLink.target = '_blank';
    fnGhLink.rel = 'noopener';
    fnGhLink.textContent = '[source \u2197]';
    fnGhLink.addEventListener('click', function(e) { e.stopPropagation(); });
    summary.appendChild(fnGhLink);
  }

  summary.appendChild(contractHint);

  // Show natspec notice as a hint below the function name
  var fnNs = natspec[contractName] ? natspec[contractName][fn.name] : null;
  if (fnNs && fnNs.notice) {
    var hintEl = document.createElement('span');
    hintEl.className = 'fn-hint';
    hintEl.textContent = fnNs.notice;
    summary.appendChild(hintEl);
  }

  var expanded = false;
  var expandedContent = null;

  summary.addEventListener('click', function() {
    expanded = !expanded;
    arrowEl.textContent = expanded ? '\u25BE' : '\u25B8';
    if (expanded && !expandedContent) {
      expandedContent = document.createElement('div');
      expandedContent.className = 'fn-expanded';

      var fnNatspec = natspec[contractName] ? natspec[contractName][fn.name] : null;
      var srcInfo = getFunctionSource(contractName, fn);

      // 1. OVERVIEW \u2014 signature + natspec
      expandedContent.appendChild(buildOverviewSection(fn, fnNatspec));

      // 2. SOURCE \u2014 function body
      if (srcInfo && srcInfo.source) {
        expandedContent.appendChild(buildSourceSection(srcInfo));
      }

      // 3. TRANSACTION \u2014 actionable form (lazy: only render on first open)
      expandedContent.appendChild(buildTransactionSection(function() {
        var formEl = renderFunctionForm(fn, contractName, getContractAddr, abi, fnNatspec);
        formEl.classList.add('fn-form-compact');
        // Remove the natspec block from inside the form \u2014 it now lives in OVERVIEW.
        var dupNatspec = formEl.querySelector('.fn-natspec');
        if (dupNatspec) dupNatspec.remove();
        return formEl;
      }));

      row.appendChild(expandedContent);
    } else if (expandedContent) {
      expandedContent.style.display = expanded ? '' : 'none';
    }
  });

  row.appendChild(summary);
  return row;
}

// --- Collapsible section builders for the expanded function view ---

// Generic collapsible: header (clickable) + body. `getBody` may be a function
// that returns a DOM node (lazy build), or a DOM node directly.
function buildFnSection(label, getBody, opts) {
  opts = opts || {};
  var meta = opts.meta || '';
  var defaultOpen = !!opts.defaultOpen;
  var bodyClass = opts.bodyClass || 'fn-section-body';

  var wrap = document.createElement('div');
  wrap.className = 'fn-section ' + (opts.extraClass || '');

  var header = document.createElement('div');
  header.className = 'fn-section-header';
  var arrow = document.createElement('span');
  arrow.className = 'fn-section-arrow';
  arrow.textContent = defaultOpen ? '▾' : '▸';
  var labelEl = document.createElement('span');
  labelEl.className = 'fn-section-label';
  labelEl.textContent = label;
  header.appendChild(arrow);
  header.appendChild(labelEl);
  if (meta) {
    var metaEl = document.createElement('span');
    metaEl.className = 'fn-section-meta';
    metaEl.textContent = meta;
    header.appendChild(metaEl);
  }
  wrap.appendChild(header);

  var body = document.createElement('div');
  body.className = bodyClass;
  body.style.display = defaultOpen ? '' : 'none';
  wrap.appendChild(body);

  var built = false;
  var open = defaultOpen;
  function ensureBuilt() {
    if (built) return;
    var node = typeof getBody === 'function' ? getBody() : getBody;
    if (node) body.appendChild(node);
    built = true;
  }
  if (defaultOpen) ensureBuilt();

  header.addEventListener('click', function() {
    open = !open;
    arrow.textContent = open ? '▾' : '▸';
    if (open) ensureBuilt();
    body.style.display = open ? '' : 'none';
  });

  return wrap;
}

// Format a Solidity function signature from an ABI entry.
function formatFunctionSignature(fn) {
  function paramStr(p) {
    var t = p.internalType || p.type;
    t = t.replace(/^struct\s+/, '').replace(/^contract\s+/, '').replace(/^enum\s+/, '');
    return p.name ? (t + ' ' + p.name) : t;
  }
  var inputs = (fn.inputs || []).map(paramStr).join(', ');
  var outputs = (fn.outputs || []).map(paramStr).join(', ');
  var mut = fn.stateMutability && fn.stateMutability !== 'nonpayable' ? ' ' + fn.stateMutability : '';
  var ret = outputs ? ' returns (' + outputs + ')' : '';
  return 'function ' + fn.name + '(' + inputs + ') external' + mut + ret;
}

function buildOverviewSection(fn, fnNatspec) {
  return buildFnSection('overview', function() {
    var wrap = document.createElement('div');
    wrap.className = 'fn-overview';

    var sig = document.createElement('pre');
    sig.className = 'fn-overview-sig';
    var code = document.createElement('code');
    code.textContent = formatFunctionSignature(fn);
    sig.appendChild(code);
    wrap.appendChild(sig);

    if (fnNatspec && fnNatspec.notice) {
      var n = document.createElement('div');
      n.className = 'fn-overview-notice';
      n.textContent = fnNatspec.notice;
      wrap.appendChild(n);
    }
    if (fnNatspec && fnNatspec.details) {
      var d = document.createElement('div');
      d.className = 'fn-overview-details';
      d.textContent = fnNatspec.details;
      wrap.appendChild(d);
    }
    if (fnNatspec && fnNatspec.params && fn.inputs && fn.inputs.length) {
      var paramKeys = Object.keys(fnNatspec.params);
      if (paramKeys.length) {
        var list = document.createElement('dl');
        list.className = 'fn-overview-params';
        for (var i = 0; i < fn.inputs.length; i++) {
          var pname = fn.inputs[i].name;
          if (!pname) continue;
          var key = fnNatspec.params[pname] ? pname : pname.replace(/^_/, '');
          var desc = fnNatspec.params[key];
          if (!desc) continue;
          var dt = document.createElement('dt');
          dt.textContent = pname;
          var dd = document.createElement('dd');
          dd.textContent = desc;
          list.appendChild(dt);
          list.appendChild(dd);
        }
        if (list.childNodes.length) wrap.appendChild(list);
      }
    }
    return wrap;
  }, { defaultOpen: true });
}

function buildSourceSection(srcInfo) {
  return buildFnSection('source', function() {
    var pre = document.createElement('pre');
    pre.className = 'fn-source-code';
    var code = document.createElement('code');
    code.textContent = srcInfo.source;
    pre.appendChild(code);
    return pre;
  }, {
    meta: 'L' + srcInfo.startLine + '–L' + srcInfo.endLine,
    defaultOpen: false,
    bodyClass: 'fn-section-body fn-source-body',
  });
}

function buildTransactionSection(getForm) {
  return buildFnSection('use', getForm, { defaultOpen: false });
}

// --- Init ---

function init() {
  restoreProjectHashFromQuery();
  syncProjectPreviewQuery();
  applySavedFont(); // apply the saved monospace font before first paint to avoid a flash
  updateFooterIpfsCid();
  mountFontSelector();
  initTabs();
  initAuditPrompt();
  renderDiscoverTab();
  renderCommonActions();
  renderDirectory();
  renderDataTab();
  renderLearnTab();
  renderBuildTab();
  renderAdminTab();
  renderWhyTab();
  onViewAsChange(function () {
    applyHash(); // re-render the active route so every "your …" read reflects the new effective account
  });
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('pageshow', onPageShow);
  applyHash(); // restore the nav tab / deep-linked project from the URL on load
}

if (REDIRECTING_FROM_BLOCKING_GATEWAY) {
  // Let the browser complete location.replace before doing any RPC-backed initialization.
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
