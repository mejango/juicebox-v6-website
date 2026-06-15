// A tiny bottom-right monospace-font sampler. Lets you try different monospace fonts live; the choice
// persists in localStorage. Google Fonts are lazy-loaded the first time they're picked.

var STORAGE_KEY = 'jb-font';
var SYSTEM_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

// label → { stack, google? }. `google` is the Google Fonts family name (loaded on demand). System has none.
var FONTS = [
  { label: 'System default', stack: SYSTEM_STACK },
  { label: 'JetBrains Mono', google: 'JetBrains Mono' },
  { label: 'IBM Plex Mono', google: 'IBM Plex Mono' },
  { label: 'Fira Code', google: 'Fira Code' },
  { label: 'Fira Mono', google: 'Fira Mono' },
  { label: 'Source Code Pro', google: 'Source Code Pro' },
  { label: 'Roboto Mono', google: 'Roboto Mono' },
  { label: 'Space Mono', google: 'Space Mono' },
  { label: 'DM Mono', google: 'DM Mono' },
  { label: 'Geist Mono', google: 'Geist Mono' },
  { label: 'Spline Sans Mono', google: 'Spline Sans Mono' },
  { label: 'Red Hat Mono', google: 'Red Hat Mono' },
  { label: 'Martian Mono', google: 'Martian Mono' },
  { label: 'Inconsolata', google: 'Inconsolata' },
  { label: 'Ubuntu Mono', google: 'Ubuntu Mono' },
  { label: 'Cousine', google: 'Cousine' },
  { label: 'Overpass Mono', google: 'Overpass Mono' },
  { label: 'Azeret Mono', google: 'Azeret Mono' },
  { label: 'Anonymous Pro', google: 'Anonymous Pro' },
  { label: 'Courier Prime', google: 'Courier Prime' },
  { label: 'Nova Mono', google: 'Nova Mono' },
];

function fontStack(f) {
  return f.google ? ('"' + f.google + '", ' + SYSTEM_STACK) : f.stack;
}

var _loaded = {};
function loadGoogleFont(name) {
  if (_loaded[name]) return;
  _loaded[name] = true;
  var href = 'https://fonts.googleapis.com/css2?family=' + encodeURIComponent(name).replace(/%20/g, '+') + ':wght@400;500;700&display=swap';
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function applyFont(f) {
  if (f.google) loadGoogleFont(f.google);
  document.documentElement.style.setProperty('--app-font', fontStack(f));
}

function readSaved() {
  try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
}
function saveChoice(label) {
  try { localStorage.setItem(STORAGE_KEY, label); } catch (_) {}
}

// Apply the saved font as early as possible (called before the selector mounts to avoid a flash).
export function applySavedFont() {
  var saved = readSaved();
  if (!saved) return;
  var f = FONTS.filter(function (x) { return x.label === saved; })[0];
  if (f) applyFont(f);
}

export function mountFontSelector() {
  if (document.querySelector('.font-selector')) return;
  applySavedFont();

  var wrap = document.createElement('div');
  wrap.className = 'font-selector';

  var label = document.createElement('span');
  label.className = 'font-selector-label';
  label.textContent = 'Aa';
  wrap.appendChild(label);

  var sel = document.createElement('select');
  sel.className = 'font-selector-sel';
  sel.title = 'Sample a monospace font';
  FONTS.forEach(function (f) {
    var o = document.createElement('option');
    o.value = f.label;
    o.textContent = f.label;
    sel.appendChild(o);
  });
  var saved = readSaved();
  sel.value = (saved && FONTS.some(function (f) { return f.label === saved; })) ? saved : 'System default';

  sel.addEventListener('change', function () {
    var f = FONTS.filter(function (x) { return x.label === sel.value; })[0];
    if (!f) return;
    applyFont(f);
    saveChoice(f.label);
  });

  wrap.appendChild(sel);
  document.body.appendChild(wrap);
}
