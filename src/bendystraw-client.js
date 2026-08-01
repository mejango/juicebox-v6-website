// src/bendystraw-client.js
// Bendystraw GraphQL client + settings panel for the DATA tab.
// Bendystraw V6 testnet API. MUST use the keyed route — the keyless /graphql endpoint sends a fixed
// Access-Control-Allow-Origin (the prod app's origin), so it CORS-fails everywhere else. The build-time
// key (BENDYSTRAW_API_KEY) is preferred; fall back to the public testnet key so a build that forgets the
// env var doesn't silently drop to the origin-locked keyless route (the key ships in the bundle regardless).

const HOST_TESTNET = 'https://testnet.bendystraw.xyz';
const HOST_MAINNET = 'https://bendystraw.xyz';
const DEFAULT_TESTNET_KEY = '3ZNJpGtazh5fwYoSW59GWDEj';
const API_KEY = (typeof __BENDYSTRAW_API_KEY__ === 'string' && __BENDYSTRAW_API_KEY__) ? __BENDYSTRAW_API_KEY__ : DEFAULT_TESTNET_KEY;
export const BENDYSTRAW_TIMEOUT_MS = 15000;
export const MAX_BENDYSTRAW_RESPONSE_BYTES = 5 * 1024 * 1024;
const RETRY_DELAYS_MS = [250, 750];
const RETRYABLE_STATUSES = { 408: true, 429: true, 500: true, 502: true, 503: true, 504: true };

// Indexer host follows the Discover network toggle: testnet.bendystraw.xyz vs bendystraw.xyz (prod).
// Initialized from the persisted choice so a mainnet reload hits the right indexer.
let _host = HOST_MAINNET;
try { if (localStorage.getItem('jb-network') === 'testnet') _host = HOST_TESTNET; } catch (_) {}
export function setBendystrawNetwork(mode) {
  _host = mode === 'mainnet' ? HOST_MAINNET : HOST_TESTNET;
}

export function getBendystrawNetwork() {
  return _host === HOST_MAINNET ? 'mainnet' : 'testnet';
}

function endpoint() {
  return API_KEY ? `${_host}/${API_KEY}/graphql` : `${_host}/graphql`;
}

export async function bendystrawQuery(graphql, variables) {
  const url = endpoint();
  var res;
  for (var attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/graphql-response+json, application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: graphql, variables: variables || {} }),
        cache: 'no-store',
        signal: AbortSignal.timeout(BENDYSTRAW_TIMEOUT_MS),
      });
      if (!RETRYABLE_STATUSES[res.status] || attempt === RETRY_DELAYS_MS.length) break;
      if (res.body && res.body.cancel) await res.body.cancel();
    } catch (error) {
      var aborted = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
      if (aborted || attempt === RETRY_DELAYS_MS.length) throw error;
    }
    await new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAYS_MS[attempt]); });
  }
  if (!res.ok) {
    throw new Error(`Bendystraw HTTP ${res.status} ${res.statusText}`);
  }
  var declaredSize = res.headers && res.headers.get ? Number(res.headers.get('content-length') || 0) : 0;
  if (declaredSize > MAX_BENDYSTRAW_RESPONSE_BYTES) throw new Error('Bendystraw response exceeds the size limit');
  var contentType = res.headers && res.headers.get ? res.headers.get('content-type') : null;
  if (contentType && contentType.toLowerCase().indexOf('json') === -1) {
    throw new Error('Bendystraw returned an invalid content type');
  }
  var body;
  if (typeof res.text === 'function') {
    var text = await res.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BENDYSTRAW_RESPONSE_BYTES) {
      throw new Error('Bendystraw response exceeds the size limit');
    }
    try { body = JSON.parse(text); } catch (_) { throw new Error('Bendystraw returned invalid JSON'); }
  } else {
    body = await res.json();
  }
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map(e => e.message).join('; ').slice(0, 500));
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'data')) throw new Error('Bendystraw response is missing data');
  return body.data;
}

export function renderBendystrawSettings(opts) {
  opts = opts || {};
  const panel = document.createElement('div');
  panel.className = 'bendystraw-settings';

  const isMainnet = _host === HOST_MAINNET;
  const note = document.createElement('div');
  note.className = 'bendystraw-settings-note';
  note.innerHTML = 'Read-only GraphQL of Juicebox V6 events. Indexer host follows the network '
    + 'toggle (' + (isMainnet ? 'bendystraw.xyz' : 'testnet.bendystraw.xyz') + '). '
    + '<a href="https://bendystraw-dev.up.railway.app/schema" target="_blank" rel="noopener">Open schema</a>.';
  panel.appendChild(note);

  const row = document.createElement('div');
  row.className = 'bendystraw-settings-row';

  // Mainnet/testnet dropdown — same control as the Discover header. Switches the indexer host, persists
  // the shared `jb-network` key (so Discover follows), and re-renders the DATA tab via the callback.
  const netSel = document.createElement('select');
  netSel.className = 'discover-net-select';
  [['mainnet', 'Mainnets'], ['testnet', 'Testnets']].forEach(function (o) {
    const op = document.createElement('option');
    op.value = o[0]; op.textContent = o[1];
    if ((isMainnet ? 'mainnet' : 'testnet') === o[0]) op.selected = true;
    netSel.appendChild(op);
  });
  netSel.title = 'Switch between mainnet and testnet deployments';
  netSel.addEventListener('change', function () {
    const mode = netSel.value === 'mainnet' ? 'mainnet' : 'testnet';
    try { localStorage.setItem('jb-network', mode); } catch (_) {}
    setBendystrawNetwork(mode);
    if (opts.onNetworkChange) opts.onNetworkChange(mode);
  });
  row.appendChild(netSel);

  panel.appendChild(row);
  return panel;
}
