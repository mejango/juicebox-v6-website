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

// Indexer host follows the Discover network toggle: testnet.bendystraw.xyz vs bendystraw.xyz (prod).
// Initialized from the persisted choice so a mainnet reload hits the right indexer.
let _host = HOST_MAINNET;
try { if (localStorage.getItem('jb-network') === 'testnet') _host = HOST_TESTNET; } catch (_) {}
export function setBendystrawNetwork(mode) {
  _host = mode === 'mainnet' ? HOST_MAINNET : HOST_TESTNET;
}

function endpoint() {
  return API_KEY ? `${_host}/${API_KEY}/graphql` : `${_host}/graphql`;
}

export async function bendystrawQuery(graphql, variables) {
  const url = endpoint();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: graphql, variables: variables || {} }),
  });
  if (!res.ok) {
    throw new Error(`Bendystraw HTTP ${res.status} ${res.statusText}`);
  }
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw new Error(body.errors.map(e => e.message).join('; '));
  }
  return body.data;
}

export function renderBendystrawSettings() {
  const panel = document.createElement('div');
  panel.className = 'bendystraw-settings';

  const isMainnet = _host === HOST_MAINNET;
  const note = document.createElement('div');
  note.className = 'bendystraw-settings-note';
  note.innerHTML = 'Read-only GraphQL of Juicebox V6 events. Indexer host follows the Discover '
    + 'network toggle (' + (isMainnet ? 'bendystraw.xyz' : 'testnet.bendystraw.xyz') + '). '
    + '<a href="https://bendystraw-dev.up.railway.app/schema" target="_blank" rel="noopener">Open schema</a>.';
  panel.appendChild(note);

  const row = document.createElement('div');
  row.className = 'bendystraw-settings-row';

  const netBadge = document.createElement('span');
  netBadge.className = 'bendystraw-net-btn active';
  netBadge.textContent = isMainnet ? 'mainnet' : 'testnet';
  row.appendChild(netBadge);

  panel.appendChild(row);
  return panel;
}
