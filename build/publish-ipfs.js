#!/usr/bin/env node
// Publish the built `dist/` directory to IPFS via Pinata. Reads PINATA_JWT from .env (never committed).
// Usage: node build/publish-ipfs.js
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WRAP = 'jb-directory'; // wrapping folder name inside the returned directory CID

function envVal(key) {
  if (process.env[key]) return process.env[key].trim();
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    const line = fs.readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith(key + '='));
    if (line) return line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

// The JWT is scoped for Pinata's v3 uploads API (the legacy /pinning endpoint + the API key/secret
// pair both return NO_SCOPES_FOUND for this account).
function bearer() {
  const jwt = envVal('PINATA_JWT');
  if (!jwt) throw new Error('PINATA_JWT not found in env or .env');
  return jwt;
}

function walk(dir, base) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ full, rel });
  }
  return out;
}

async function main() {
  if (!fs.existsSync(DIST)) throw new Error('dist/ not found — run `npm run build` first');
  const jwt = bearer();
  const files = walk(DIST, '');
  if (!files.length) throw new Error('dist/ is empty');

  const form = new FormData();
  for (const f of files) {
    const buf = fs.readFileSync(f.full);
    // The leading path segment becomes the wrapping directory in the returned CID.
    form.append('file', new Blob([buf]), `${WRAP}/${f.rel}`);
  }
  form.append('network', 'public');
  form.append('name', WRAP);

  console.log(`Uploading ${files.length} files (${(files.reduce((a, f) => a + fs.statSync(f.full).size, 0) / 1e6).toFixed(1)} MB) to Pinata…`);
  const res = await fetch('https://uploads.pinata.cloud/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${text}`);
  const out = JSON.parse(text);
  const cid = out.data && out.data.cid;
  if (!cid) throw new Error('No CID in response: ' + text);
  console.log('\n✅ Published');
  console.log(`CID:     ${cid}`);
  console.log(`Pinata:  https://gateway.pinata.cloud/ipfs/${cid}/`);
  console.log(`ipfs.io: https://ipfs.io/ipfs/${cid}/`);
  console.log(`dweb:    https://${cid}.ipfs.dweb.link/`);
}

main().catch((e) => { console.error('\n❌ ' + e.message); process.exit(1); });
