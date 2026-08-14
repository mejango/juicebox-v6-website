import sharp from 'sharp';

const CHAIN_IDS = Object.freeze({
  eth: 1,
  sep: 11155111,
  arb: 42161,
  arbsep: 421614,
  base: 8453,
  basesep: 84532,
  op: 10,
  opsep: 11155420,
});
const TESTNET_IDS = new Set([11155111, 421614, 84532, 11155420]);
const MAINNET_HOST = 'https://bendystraw.up.railway.app';
const TESTNET_HOST = 'https://testnet.bendystraw.xyz';
const DEFAULT_PUBLIC_KEY = '3ZNJpGtazh5fwYoSW59GWDEj';
const QUERY_TIMEOUT_MS = 8000;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const IPFS_GATEWAYS = [
  'https://gateway.pinata.cloud/ipfs/',
  'https://dweb.link/ipfs/',
  'https://ipfs.io/ipfs/',
];

const PROJECT_QUERY = `query ProjectPreview($projectId: Float!, $chainId: Float!, $version: Float!) {
  project(projectId: $projectId, chainId: $chainId, version: $version) {
    suckerGroupId balance paymentsCount name description projectTagline logoUri metadataUri metadata tokenSymbol decimals
  }
}`;

const GROUP_QUERY = `query ProjectPreviewGroup($id: String!) {
  suckerGroup(id: $id) {
    paymentsCount
    projects(limit: 100) { items { balance tokenSymbol decimals } }
  }
}`;

export function parseProjectReference(value) {
  const match = /^([a-z]+|\d+):([1-9]\d*)$/i.exec(String(value || '').trim());
  if (!match) return null;
  const slug = match[1].toLowerCase();
  const chainId = CHAIN_IDS[slug] || Number(slug);
  const projectId = Number(match[2]);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
  return {
    slug,
    chainId,
    projectId,
    key: `${slug}:${projectId}`,
    network: TESTNET_IDS.has(chainId) ? 'testnet' : 'mainnet',
  };
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function ipfsPath(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return null;
  const path = input.replace(/^ipfs:\/\//i, '').replace(/^https?:\/\/[^/]+\/ipfs\//i, '');
  if (path === input && /^[a-z][a-z\d+.-]*:/i.test(input)) return null;
  if (!/^[A-Za-z\d._~/-]{20,512}$/.test(path) || path.includes('..')) return null;
  return path;
}

async function boundedResponseBytes(response, maximum) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximum) throw new Error('response too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error('response too large');
  return bytes;
}

async function fetchIpfsJson(uri) {
  const path = ipfsPath(uri);
  if (!path) return null;
  for (const gateway of IPFS_GATEWAYS) {
    try {
      const response = await fetch(gateway + path, {
        cache: 'no-store',
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
      if (!response.ok) continue;
      const bytes = await boundedResponseBytes(response, MAX_JSON_BYTES);
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Try the next independent gateway.
    }
  }
  return null;
}

async function bendystrawQuery(network, query, variables) {
  const host = network === 'testnet' ? TESTNET_HOST : MAINNET_HOST;
  const key = String(process.env.BENDYSTRAW_API_KEY || DEFAULT_PUBLIC_KEY).trim();
  const endpoint = key ? `${host}/${encodeURIComponent(key)}/graphql` : `${host}/graphql`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/graphql-response+json, application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Bendystraw returned ${response.status}`);
  const bytes = await boundedResponseBytes(response, MAX_JSON_BYTES);
  const body = JSON.parse(new TextDecoder().decode(bytes));
  if (body.errors?.length) throw new Error(String(body.errors[0]?.message || 'GraphQL error'));
  return body.data;
}

function formatRawAmount(raw, decimals) {
  const amount = BigInt(raw || 0);
  const places = BigInt(decimals);
  const scale = 10n ** places;
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
}

export function formatPreviewBalance(deployments) {
  const buckets = new Map();
  for (const row of deployments || []) {
    const symbol = typeof row?.tokenSymbol === 'string' ? row.tokenSymbol.trim() : '';
    const decimals = Number(row?.decimals);
    if (!symbol || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) continue;
    try {
      const key = `${symbol.toUpperCase()}:${decimals}`;
      const current = buckets.get(key);
      buckets.set(key, {
        symbol,
        decimals,
        amount: (current?.amount || 0n) + BigInt(row.balance || 0),
      });
    } catch {
      // Unknown stays unknown.
    }
  }
  const values = [...buckets.values()]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((bucket) => `${formatRawAmount(bucket.amount, bucket.decimals)} ${bucket.symbol}`);
  if (!values.length) return 'Unavailable';
  if (values.length <= 2) return values.join(' + ');
  return `${values.slice(0, 2).join(' + ')} + ${values.length - 2} more`;
}

export function projectPreviewSlogan(...values) {
  for (const value of values) {
    const text = typeof value === 'string'
      ? value
          .replace(/<br\s*\/?>/giu, ' ')
          .replace(/<[^>]+>/gu, ' ')
          .replace(/&amp;/gu, '&')
          .replace(/&quot;/gu, '"')
          .replace(/&#39;|&apos;/gu, "'")
          .replace(/&nbsp;/gu, ' ')
          .replace(/\s+/gu, ' ')
          .trim()
      : '';
    if (text) return text.slice(0, 240);
  }
  return '';
}

export async function loadProjectPreview(reference) {
  const projectResult = await bendystrawQuery(reference.network, PROJECT_QUERY, {
    projectId: reference.projectId,
    chainId: reference.chainId,
    version: 6,
  });
  const project = projectResult?.project;
  if (!project) return null;

  const [freshMetadata, groupResult] = await Promise.all([
    fetchIpfsJson(project.metadataUri).catch(() => null),
    project.suckerGroupId
      ? bendystrawQuery(reference.network, GROUP_QUERY, { id: project.suckerGroupId }).catch(
          () => null,
        )
      : Promise.resolve(null),
  ]);
  const metadata = { ...parseMetadata(project.metadata), ...(freshMetadata || {}) };
  const group = groupResult?.suckerGroup;
  const deployments = group?.projects?.items?.length ? group.projects.items : [project];
  const name = String(metadata.name || project.name || `Project ${reference.projectId}`).trim();
  const tagline = projectPreviewSlogan(
    metadata.projectTagline,
    metadata.tagline,
    metadata.description,
    project.projectTagline,
    project.description,
  );

  return {
    name: name.slice(0, 120),
    tagline: tagline.slice(0, 240),
    logoUri: metadata.logoUri || project.logoUri || null,
    balance: formatPreviewBalance(deployments),
    paymentsCount: Number.isSafeInteger(Number(group?.paymentsCount))
      ? Math.max(0, Number(group.paymentsCount))
      : Math.max(0, Number(project.paymentsCount) || 0),
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(value, width, lines) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  const rows = [];
  let row = '';
  for (const word of words) {
    const next = row ? `${row} ${word}` : word;
    if (next.length <= width || !row) row = next;
    else {
      rows.push(row);
      row = word;
      if (rows.length === lines - 1) break;
    }
  }
  if (row && rows.length < lines) rows.push(row);
  if (words.join(' ').length > rows.join(' ').length && rows.length) {
    rows[rows.length - 1] = `${rows[rows.length - 1].slice(0, Math.max(1, width - 1)).trim()}…`;
  }
  return rows;
}

async function safeLogoDataUrl(source) {
  const input = typeof source === 'string' ? source.trim() : '';
  if (!input) return null;
  let bytes;
  if (/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,/i.test(input)) {
    try {
      bytes = Buffer.from(input.slice(input.indexOf(',') + 1), 'base64');
      if (!bytes.length || bytes.length > MAX_LOGO_BYTES) return null;
    } catch {
      return null;
    }
  } else {
    const path = ipfsPath(input);
    if (!path) return null;
    for (const gateway of IPFS_GATEWAYS) {
      try {
        const response = await fetch(gateway + path, {
          cache: 'no-store',
          signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        });
        if (!response.ok) continue;
        bytes = Buffer.from(await boundedResponseBytes(response, MAX_LOGO_BYTES));
        break;
      } catch {
        // Try the next gateway.
      }
    }
  }
  if (!bytes?.length) return null;
  const textPrefix = bytes.subarray(0, Math.min(bytes.length, 32_768)).toString('utf8');
  if (
    /<svg(?:\s|>)/i.test(textPrefix) &&
    /<(?:script|foreignObject|iframe|object|embed|image|use|style)\b|(?:href|src|on[a-z]+)\s*=|<!doctype|<\?xml-stylesheet/i.test(
      textPrefix,
    )
  ) {
    return null;
  }
  try {
    const normalized = await sharp(bytes, { limitInputPixels: 16_000_000 })
      .resize(330, 330, { fit: 'contain', withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${normalized.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function renderProjectPreviewPng(preview, suppliedLogoDataUrl) {
  const logoDataUrl = suppliedLogoDataUrl === undefined
    ? await safeLogoDataUrl(preview.logoUri)
    : suppliedLogoDataUrl;
  const nameRows = wrapText(preview.name, 24, 2);
  const taglineRows = wrapText(preview.tagline, 46, 2);
  const nameSize = preview.name.length > 34 ? 48 : 58;
  const nameMarkup = nameRows
    .map((row, index) => `<tspan x="500" dy="${index ? nameSize * 1.05 : 0}">${escapeXml(row)}</tspan>`)
    .join('');
  const taglineMarkup = taglineRows
    .map((row, index) => `<tspan x="500" dy="${index ? 36 : 0}">${escapeXml(row)}</tspan>`)
    .join('');
  const initial = escapeXml(String(preview.name || 'J').charAt(0).toUpperCase());
  const logoMarkup = logoDataUrl
    ? `<image href="${logoDataUrl}" x="82" y="88" width="330" height="330" preserveAspectRatio="xMidYMid meet"/>`
    : `<rect x="82" y="88" width="330" height="330" rx="34" fill="#ef476f"/><text x="247" y="310" text-anchor="middle" font-size="170" font-weight="800" fill="#fffdf6">${initial}</text>`;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#fffdf6"/>
    <rect x="58" y="64" width="378" height="378" rx="42" fill="#ffffff" stroke="#172121" stroke-width="4"/>
    ${logoMarkup}
    <text x="500" y="130" font-family="Arial,Helvetica,sans-serif" font-size="${nameSize}" font-weight="800" fill="#172121">${nameMarkup}</text>
    <text x="500" y="${nameRows.length > 1 ? 265 : 215}" font-family="Arial,Helvetica,sans-serif" font-size="27" fill="#536363">${taglineMarkup}</text>
    <rect x="500" y="390" width="405" height="126" rx="20" fill="#dff7ef" stroke="#172121" stroke-width="3"/>
    <text x="525" y="426" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="700" fill="#536363">BALANCE</text>
    <text x="525" y="479" font-family="Arial,Helvetica,sans-serif" font-size="31" font-weight="800" fill="#172121">${escapeXml(preview.balance)}</text>
    <rect x="927" y="390" width="215" height="126" rx="20" fill="#ffd9e2" stroke="#172121" stroke-width="3"/>
    <text x="952" y="426" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="700" fill="#536363">PAYMENTS</text>
    <text x="952" y="479" font-family="Arial,Helvetica,sans-serif" font-size="31" font-weight="800" fill="#172121">${escapeXml(Number(preview.paymentsCount || 0).toLocaleString('en-US'))}</text>
    <circle cx="78" cy="574" r="10" fill="#36b5a8"/><circle cx="104" cy="574" r="10" fill="#ef476f"/><circle cx="130" cy="574" r="10" fill="#f4a261"/>
    <text x="154" y="583" font-family="Arial,Helvetica,sans-serif" font-size="24" font-weight="800" letter-spacing="2" fill="#172121">JUICE SCAN</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function injectProjectPreviewMeta(html, preview, { pageUrl, imageUrl }) {
  const title = `${preview.name} — Juice Scan`;
  const description = preview.tagline || `View ${preview.name} on Juice Scan.`;
  const tags = [
    `<meta name="description" content="${escapeHtmlAttribute(description)}" data-project-preview>`,
    `<meta property="og:type" content="website" data-project-preview>`,
    `<meta property="og:title" content="${escapeHtmlAttribute(title)}" data-project-preview>`,
    `<meta property="og:description" content="${escapeHtmlAttribute(description)}" data-project-preview>`,
    `<meta property="og:url" content="${escapeHtmlAttribute(pageUrl)}" data-project-preview>`,
    `<meta property="og:image" content="${escapeHtmlAttribute(imageUrl)}" data-project-preview>`,
    '<meta property="og:image:width" content="1200" data-project-preview>',
    '<meta property="og:image:height" content="630" data-project-preview>',
    '<meta name="twitter:card" content="summary_large_image" data-project-preview>',
    `<meta name="twitter:title" content="${escapeHtmlAttribute(title)}" data-project-preview>`,
    `<meta name="twitter:description" content="${escapeHtmlAttribute(description)}" data-project-preview>`,
    `<meta name="twitter:image" content="${escapeHtmlAttribute(imageUrl)}" data-project-preview>`,
  ].join('\n');
  const projectShell = html.replace(/<meta\b[^>]*\bdata-default-preview\b[^>]*>\s*/giu, '');
  return projectShell.replace('<head>', `<head>\n${tags}`);
}
