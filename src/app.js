// src/app.js
// Entry point: tabs, wallet, directory rendering
// Chain selection is per-function-form, not global.

import { registry, contracts, meta, natspec, categories, commonActions, getFunctions, getAddress, getFunctionSource, getGithubUrl } from './abi-registry.js';
import { renderFunctionForm } from './form.js';
import { getAuditPrompt, getComponentAuditPrompt } from './prompts.js';
import { renderStyleEditor } from './components.js';
import { buildEmbedUrl, getAccount, connect, onWalletChange, eagerConnect, truncAddr } from './component-base.js';
import { renderLearnTab, renderBuildTab, renderWhyTab } from './learn-build.js';
import { renderDiscoverTab, applyDiscoverRoute } from './discover.js';
import { renderDataTab } from './data-tab.js';
import { mountFontSelector, applySavedFont } from './font-selector.js';

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
var NAV_TO_TAB = { discover: 'discover', actions: 'common', learn: 'learn', build: 'build', api: 'directory', data: 'data', why: 'why' };
var TAB_TO_NAV = { discover: 'discover', common: 'actions', learn: 'learn', build: 'build', directory: 'api', data: 'data', why: 'why' };

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
    var updateConnect = function() {
      var acc = getAccount();
      connectBtn.textContent = acc ? truncAddr(acc) : 'Connect wallet';
      connectBtn.classList.toggle('connected', !!acc);
      connectBtn.title = acc || 'Connect a wallet';
    };
    updateConnect();
    onWalletChange(updateConnect);
    connectBtn.addEventListener('click', function() { if (!getAccount()) connect().catch(function() {}); });
  }
  // Restore a prior wallet connection silently (no prompt) so a refresh keeps the user connected.
  eagerConnect();
}

// Parse the hash and apply it: pick the nav tab, and (for discover) open the project route.
function applyHash() {
  var raw = (location.hash || '').replace(/^#\/?/, '');
  var nav, projectRoute = null;
  if (raw === '' || raw === 'discover') { nav = 'discover'; }
  else if (raw.indexOf(':') !== -1) { nav = 'discover'; projectRoute = raw; } // <slug>:<id>[/tab]
  else { nav = raw.split('/')[0]; }
  activateNavTab(NAV_TO_TAB[nav] || 'discover');
  if ((NAV_TO_TAB[nav] || 'discover') === 'discover') applyDiscoverRoute(projectRoute);
}

function onHashChange() {
  // Programmatic hash updates (card open, detail tab, back-to-grid) set this flag so we don't re-render.
  if (window.__suppressHash) { window.__suppressHash = false; return; }
  applyHash();
}

function initAuditPrompt() {
  var link = document.getElementById('audit-prompt-link');
  if (!link) return;
  link.addEventListener('click', function(e) {
    e.preventDefault();
    var prompt = getAuditPrompt();
    navigator.clipboard.writeText(prompt).then(function() {
      link.textContent = 'COPIED TO CLIPBOARD';
      setTimeout(function() { link.textContent = '[copy system audit prompt]'; }, 2000);
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

  var wipBanner = document.createElement('div');
  wipBanner.className = 'discover-header';
  wipBanner.textContent = 'Work in progress';
  container.appendChild(wipBanner);

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
        var compTitle = componentEl._compTitle || '';
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
        var styleToggle = document.createElement('a');
        styleToggle.className = 'style-toggle-btn';
        styleToggle.textContent = '[style]';
        styleToggle.href = '#';
        selectorWrap.appendChild(styleToggle);

        if (compGetEmbedParams) {
          var copyEmbedBtn = document.createElement('a');
          copyEmbedBtn.className = 'style-toggle-btn';
          copyEmbedBtn.textContent = '[embed]';
          copyEmbedBtn.href = '#';
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

        var copyPromptLink = document.createElement('a');
        copyPromptLink.className = 'fn-copy-prompt';
        copyPromptLink.textContent = '[ask your LLM]';
        copyPromptLink.href = '#';
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
  renderWhyTab();
  window.addEventListener('hashchange', onHashChange);
  applyHash(); // restore the nav tab / deep-linked project from the URL on load
}

if (REDIRECTING_FROM_BLOCKING_GATEWAY) {
  // Let the browser complete location.replace before doing any RPC-backed initialization.
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
