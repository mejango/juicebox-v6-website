// src/ipfs-pin.js
// IPFS pinning for the project-create flow, via Pinata.
//
// A SCOPED, PUBLIC Pinata key is baked in at build time (from `PINATA_PUBLIC_JWT` via esbuild's
// `__PINATA_JWT__` define) so the Create flow pins on users' behalf without per-user setup. It is public/
// extractable by design — must be scoped to pinFileToIPFS + pinJSONToIPFS and rate-limited. A user's own JWT
// in localStorage ('jb-pinata-jwt', set via the create-flow inline field) still takes precedence if present.
//
// Endpoints (classic Pinata API, scoped-key friendly):
//   POST https://api.pinata.cloud/pinning/pinFileToIPFS   (multipart, for logo / NFT images)
//   POST https://api.pinata.cloud/pinning/pinJSONToIPFS   (json, for project + NFT metadata)
// Both return { IpfsHash: "Qm…", PinSize, Timestamp }; we surface it as "ipfs://Qm…".

import { bytesToHex } from 'viem';

var JWT_KEY = 'jb-pinata-jwt';
// v3 uploads API (the only one a scoped `pinataKey`/JWT works on — the legacy /pinning endpoints return
// 403 NO_SCOPES_FOUND for these keys). Multipart `file` + `network: public`; response is { data: { cid } }.
var UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';

// No baked-in JWT in the public bundle (see header). Defined empty by esbuild; kept guarded for safety.
var BUILTIN_JWT = (typeof __PINATA_JWT__ === 'string' && __PINATA_JWT__) ? __PINATA_JWT__ : '';

export function getPinataJwt() {
  try { var v = localStorage.getItem(JWT_KEY); if (v) return v; } catch (_) { /* private mode — fall through */ }
  return BUILTIN_JWT;
}

export function setPinataJwt(value) {
  try {
    if (value) localStorage.setItem(JWT_KEY, value.trim());
    else localStorage.removeItem(JWT_KEY);
  } catch (_) { /* private mode / sandboxed — ignore */ }
}

export function hasPinata() { return !!getPinataJwt(); }

// Settings strip for the DATA tab — mirrors renderBendystrawSettings. Lets the user paste a Pinata
// JWT used by the Create flow to pin logos/metadata. Stored in this browser only.
export function renderPinataSettings() {
  var panel = document.createElement('div');
  panel.className = 'bendystraw-settings';
  var note = document.createElement('div');
  note.className = 'bendystraw-settings-note';
  note.innerHTML = 'IPFS pinning for the <b>+ Create</b> flow (project logo + metadata). '
    + 'Paste a <a href="https://app.pinata.cloud/developers/api-keys" target="_blank" rel="noopener">Pinata JWT</a> '
    + 'with pinFileToIPFS + pinJSONToIPFS scopes. Stored only in this browser.';
  panel.appendChild(note);
  var row = document.createElement('div');
  row.className = 'bendystraw-settings-row';
  var input = document.createElement('input');
  input.type = 'password';
  input.className = 'field bendystraw-key-input';
  input.placeholder = 'pinata JWT (for project creation)';
  input.value = getPinataJwt();
  input.autocomplete = 'off';
  input.spellcheck = false;
  var t = null;
  input.addEventListener('input', function () {
    if (t) clearTimeout(t);
    t = setTimeout(function () { setPinataJwt(input.value.trim()); }, 250);
  });
  row.appendChild(input);
  panel.appendChild(row);
  return panel;
}

// Pin a File/Blob. Returns "ipfs://<cid>". Throws on misconfig or HTTP error (caller shows the message).
export async function pinFile(file, name) {
  var jwt = getPinataJwt();
  if (!jwt) throw new Error('No Pinata JWT set — add one in settings, or paste an ipfs:// hash.');
  var fname = (file && file.name) || name || 'upload';
  var form = new FormData();
  form.append('file', file, fname);
  form.append('network', 'public');
  form.append('name', name || fname);
  var res = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: form });
  return await readPinResponse(res);
}

// Pin a JSON object. Returns "ipfs://<cid>". (v3 is file-based, so the JSON is uploaded as a .json file.)
export async function pinJson(obj, name) {
  var jwt = getPinataJwt();
  if (!jwt) throw new Error('No Pinata JWT set — add one in settings, or paste an ipfs:// hash.');
  var base = name || obj.name || 'metadata';
  var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  var form = new FormData();
  form.append('file', blob, base + '.json');
  form.append('network', 'public');
  form.append('name', base);
  var res = await fetch(UPLOAD_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt }, body: form });
  return await readPinResponse(res);
}

async function readPinResponse(res) {
  var text = '';
  try { text = (await res.text()) || ''; } catch (_) { text = ''; }
  if (!res.ok) throw new Error('Pinata HTTP ' + res.status + (text ? (': ' + text.slice(0, 200)) : ''));
  var body; try { body = JSON.parse(text); } catch (_) { body = null; }
  // v3 uploads API returns { data: { cid } }; tolerate the legacy { IpfsHash } shape too.
  var cid = body && ((body.data && body.data.cid) || body.IpfsHash);
  if (!cid) throw new Error('Pinata returned no CID');
  return 'ipfs://' + cid;
}

// --- CID helpers ---

var B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// Decode a base58 (Bitcoin alphabet) string to a Uint8Array.
function base58Decode(str) {
  var bytes = [0];
  for (var i = 0; i < str.length; i++) {
    var value = B58_ALPHABET.indexOf(str[i]);
    if (value === -1) throw new Error('Invalid base58 character: ' + str[i]);
    var carry = value;
    for (var j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // Leading '1's in base58 are leading zero bytes.
  for (var k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return new Uint8Array(bytes.reverse());
}

// Strip "ipfs://" / gateway prefixes and any path, returning the bare CID.
function bareCid(uri) {
  if (!uri) return '';
  var s = String(uri).trim();
  if (s.indexOf('ipfs://') === 0) s = s.slice('ipfs://'.length);
  var slash = s.indexOf('/');
  if (slash !== -1) s = s.slice(0, slash);
  return s;
}

// Encode a CIDv0 ("Qm…") IPFS URI into the bytes32 the 721 hook stores (JB721TierConfig.encodedIpfsUri).
// CIDv0 = base58(0x12 0x20 <32-byte sha256 digest>); we drop the 2-byte multihash prefix and keep the
// 32-byte digest. CIDv1 ("b…") isn't supported here (Pinata returns CIDv0 by default).
export function encodeIpfsUriToBytes32(uri) {
  var cid = bareCid(uri);
  if (!cid) return '0x0000000000000000000000000000000000000000000000000000000000000000';
  if (cid[0] !== 'Q') {
    throw new Error('Only CIDv0 (Qm…) NFT image hashes are supported; got: ' + cid.slice(0, 8) + '…');
  }
  var raw = base58Decode(cid);
  if (raw.length !== 34 || raw[0] !== 0x12 || raw[1] !== 0x20) {
    throw new Error('Unexpected CIDv0 multihash for: ' + cid.slice(0, 8) + '…');
  }
  return bytesToHex(raw.slice(2)); // 32-byte sha256 digest → 0x…
}
