// src/bendystraw-format.js
// Type-aware cell formatters for Bendystraw query results.
// Each formatter returns a DOM node so callers can append directly.

import { CHAINS, ipfsHttpUrl } from './chain.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

function explorerUrl(chainId) {
  const chain = CHAINS[chainId];
  return (chain && chain.blockExplorers && chain.blockExplorers.default && chain.blockExplorers.default.url) || null;
}

function shorten(s, head, tail) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= head + tail + 2) return str;
  return str.slice(0, head) + '…' + str.slice(-tail);
}

export function text(value) {
  const span = document.createElement('span');
  span.textContent = value == null ? '—' : String(value);
  return span;
}

export function number(value) {
  const span = document.createElement('span');
  if (value == null || value === '') { span.textContent = '—'; return span; }
  const n = typeof value === 'string' ? Number(value) : value;
  span.textContent = Number.isFinite(n) ? n.toLocaleString() : String(value);
  return span;
}

export function address(value, row) {
  const span = document.createElement('span');
  if (!value || value === ZERO_ADDRESS) {
    span.className = 'data-cell-address muted';
    span.textContent = '0x0…0';
    span.title = ZERO_ADDRESS;
    return span;
  }
  const chainId = row && row.chainId;
  const url = chainId && explorerUrl(chainId);
  if (url) {
    const a = document.createElement('a');
    a.href = url + '/address/' + value;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'data-cell-address';
    a.textContent = shorten(value, 6, 4);
    a.title = value;
    return a;
  }
  span.className = 'data-cell-address';
  span.textContent = shorten(value, 6, 4);
  span.title = value;
  return span;
}

export function txHash(value, row) {
  const span = document.createElement('span');
  if (!value) { span.textContent = '—'; return span; }
  const chainId = row && row.chainId;
  const url = chainId && explorerUrl(chainId);
  if (url) {
    const a = document.createElement('a');
    a.href = url + '/tx/' + value;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'data-cell-txhash';
    a.textContent = shorten(value, 8, 6);
    a.title = value;
    return a;
  }
  span.className = 'data-cell-txhash';
  span.textContent = shorten(value, 8, 6);
  span.title = value;
  return span;
}

export function timestamp(value) {
  const span = document.createElement('span');
  if (!value) { span.textContent = '—'; return span; }
  const sec = typeof value === 'string' ? parseInt(value, 10) : value;
  if (!Number.isFinite(sec)) { span.textContent = String(value); return span; }
  const date = new Date(sec * 1000);
  const now = Date.now();
  const diffSec = (now - date.getTime()) / 1000;
  let rel;
  if (diffSec < 60) rel = Math.floor(diffSec) + 's ago';
  else if (diffSec < 3600) rel = Math.floor(diffSec / 60) + 'm ago';
  else if (diffSec < 86400) rel = Math.floor(diffSec / 3600) + 'h ago';
  else if (diffSec < 86400 * 30) rel = Math.floor(diffSec / 86400) + 'd ago';
  else rel = date.toISOString().slice(0, 10);
  span.textContent = rel;
  span.title = date.toISOString();
  span.className = 'data-cell-time';
  return span;
}

// Raw integer fallback for indexed amounts whose event/table does not carry a token or decimals.
// Showing base units is less pretty than guessing ETH/USDC, but it is honest and reversible.
export function rawAmount(value) {
  const span = document.createElement('span');
  if (value == null || value === '') { span.textContent = '—'; return span; }
  try {
    span.textContent = BigInt(String(value).split('.')[0]).toLocaleString() + ' raw';
    span.title = 'Raw base units; this Bendystraw row does not identify a denomination.';
  } catch (_) {
    span.textContent = String(value);
  }
  span.className = 'data-cell-raw-amount';
  return span;
}

// Format an amount only when its precision is actually present in the row/column metadata. Currency 1 is
// ETH and currency 2 is USD; USDC accounting currencies are address-derived IDs, never the number 2.
export function amount(value, row, opts) {
  const span = document.createElement('span');
  if (value == null || value === '') { span.textContent = '—'; return span; }
  const decimals = opts && opts.decimals != null ? Number(opts.decimals)
    : (row && row.decimals != null ? Number(row.decimals) : null);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return rawAmount(value);
  const currency = opts && opts.currency != null ? Number(opts.currency)
    : (row && row.currency != null ? Number(row.currency) : null);
  const symbol = (opts && opts.symbol)
    || (opts && opts.symbolKey && row && row[opts.symbolKey])
    || (currency === 1 ? 'ETH' : (currency === 2 ? 'USD' : ''));
  const precision = opts && opts.precision != null ? Number(opts.precision) : (symbol === 'USD' ? 2 : 4);
  try {
    const raw = BigInt(String(value).split('.')[0]);
    const divisor = BigInt(10) ** BigInt(decimals);
    const negative = raw < 0n;
    const absolute = negative ? -raw : raw;
    const whole = absolute / divisor;
    const frac = absolute % divisor;
    const shownPrecision = Math.max(0, Math.min(precision, decimals));
    // Build fractional with full precision then trim. A non-zero value below the displayed precision is
    // explicitly marked as such instead of being rendered as zero (and zero-decimal contexts never gain a dot).
    const fracStr = shownPrecision ? (frac.toString().padStart(decimals, '0')).slice(0, shownPrecision) : '';
    const belowPrecision = whole === 0n && frac > 0n && shownPrecision > 0 && /^0+$/.test(fracStr);
    if (belowPrecision) {
      span.textContent = (negative ? '>-0.' : '<0.') + '0'.repeat(shownPrecision - 1) + '1' + (symbol ? ' ' + symbol : '');
    } else {
      span.textContent = (negative ? '-' : '') + whole.toString() + (shownPrecision > 0 ? '.' + fracStr : '') + (symbol ? ' ' + symbol : '');
    }
    span.title = BigInt(String(value).split('.')[0]).toLocaleString() + ' raw base units';
  } catch (e) {
    span.textContent = String(value);
  }
  return span;
}

// volumeUsd / amountUsd are 18-decimal scaled USD. Use BigInt to avoid Number precision loss.
export function scaledUsdToNumber(value) {
  if (value == null || value === '') return null;
  try {
    return Number(BigInt(String(value).split('.')[0]) / 1000000000000n) / 1e6;
  } catch (_) {
    return null;
  }
}

export function volumeUsd(value) {
  const span = document.createElement('span');
  if (value == null || value === '' || value === '0') { span.textContent = '—'; return span; }
  try {
    const usd = scaledUsdToNumber(value);
    if (usd == null) throw new Error('invalid USD amount');
    let str;
    if (usd >= 1_000_000) str = '$' + (usd / 1_000_000).toFixed(2) + 'M';
    else if (usd >= 1_000) str = '$' + (usd / 1_000).toFixed(2) + 'k';
    else if (usd >= 1) str = '$' + usd.toFixed(2);
    else str = '$' + usd.toFixed(4);
    span.textContent = str;
  } catch (e) { span.textContent = String(value); }
  return span;
}

export function bigint(value) {
  const span = document.createElement('span');
  if (value == null || value === '') { span.textContent = '—'; return span; }
  try {
    const n = BigInt(String(value).split('.')[0]);
    span.textContent = n.toLocaleString();
  } catch (e) { span.textContent = String(value); }
  span.className = 'data-cell-bigint';
  return span;
}

export function bool(value) {
  const span = document.createElement('span');
  span.textContent = value === true ? 'yes' : value === false ? 'no' : '—';
  span.className = 'data-cell-bool';
  return span;
}

export function chainName(value) {
  const span = document.createElement('span');
  const chain = value && CHAINS[Number(value)];
  if (chain) {
    span.textContent = chain.name;
    span.title = 'Chain ID ' + value;
  } else {
    span.textContent = value == null ? '—' : String(value);
  }
  span.className = 'data-cell-chain';
  return span;
}

export function uri(value) {
  if (!value) { const s = document.createElement('span'); s.textContent = '—'; return s; }
  let href = String(value);
  href = ipfsHttpUrl(href);
  // Indexed metadata is user-controlled. Only real web URLs become clickable; render every other scheme inert.
  if (!/^https?:\/\//i.test(href)) return text(shorten(value, 12, 12));
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = shorten(value, 12, 12);
  a.title = String(value);
  a.className = 'data-cell-uri';
  return a;
}

export function json(value) {
  const wrap = document.createElement('details');
  wrap.className = 'data-cell-json';
  const summary = document.createElement('summary');
  if (value == null) { summary.textContent = '—'; wrap.appendChild(summary); return wrap; }
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch (e) { /* leave as string */ }
  }
  const preview = typeof parsed === 'object'
    ? JSON.stringify(parsed).slice(0, 40) + (JSON.stringify(parsed).length > 40 ? '…' : '')
    : String(parsed).slice(0, 40);
  summary.textContent = preview;
  wrap.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = typeof parsed === 'object' ? JSON.stringify(parsed, null, 2) : String(parsed);
  wrap.appendChild(pre);
  return wrap;
}

export function svg(value) {
  if (!value) { const s = document.createElement('span'); s.textContent = '—'; return s; }
  const wrap = document.createElement('div');
  wrap.className = 'data-cell-svg';
  // Never inject indexed SVG into the live document: scripts, event handlers, foreignObject, and external
  // resource attributes are all active through innerHTML. An <img> renders the pixels in an isolated image
  // context instead.
  const trimmed = String(value).trim();
  if (trimmed.toLowerCase().startsWith('<svg')) {
    const img = document.createElement('img');
    img.alt = 'Indexed SVG preview';
    img.loading = 'lazy';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(trimmed);
    wrap.appendChild(img);
  } else {
    wrap.textContent = shorten(value, 20, 8);
  }
  return wrap;
}

// Permissions are an array of permission IDs. Render compactly.
function permissionList(value) {
  const span = document.createElement('span');
  if (!Array.isArray(value) || value.length === 0) { span.textContent = '—'; return span; }
  span.textContent = '[' + value.join(', ') + ']';
  span.title = value.length + ' permission(s)';
  return span;
}

// Generic dispatch — used by data-tab when rendering a column.
export const FORMATTERS = {
  text, number, address, txHash, timestamp, amount, volumeUsd,
  rawAmount, bigint, bool, chainName, uri, json, svg, permissionList,
};
