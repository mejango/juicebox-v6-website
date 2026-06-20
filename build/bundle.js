// build/bundle.js
// Bundles src/ → dist/ as static, CSP-friendly assets
// No minification — readable output for auditability

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');
const ENV = loadEnvFile(path.join(__dirname, '..', '.env'));

async function build() {
  // Bundle JS
  const jsResult = await esbuild.build({
    entryPoints: [path.join(SRC, 'app.js')],
    bundle: true,
    format: 'iife',
    write: false,
    minify: false,
    sourcemap: false,
    define: {
      __BENDYSTRAW_API_KEY__: JSON.stringify(process.env.BENDYSTRAW_API_KEY || ENV.BENDYSTRAW_API_KEY || ''),
      // Baked-in PUBLIC Pinata key so the Create flow pins logos/metadata on users' behalf (no per-user setup).
      // This bundle is public, so the baked value IS extractable — use ONLY a SCOPED (pinFileToIPFS +
      // pinJSONToIPFS only), rate-limited, rotatable key here. It is `PINATA_PUBLIC_JWT`, deliberately SEPARATE
      // from `PINATA_JWT` (the full-access publish key used only by build/publish-ipfs.js, never baked in).
      __PINATA_JWT__: JSON.stringify(process.env.PINATA_PUBLIC_JWT || ENV.PINATA_PUBLIC_JWT || ''),
    },
  });
  const js = jsResult.outputFiles[0].text;

  // Read HTML shell
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

  // Fill build metadata. JS and CSS are emitted as same-origin files so IPFS
  // gateways with default-src 'self' CSP can still run the app.
  const final = html
    .replace('__BUILD_DATE__', new Date().toISOString().split('T')[0])
    .replace('__GIT_HASH__', getGitHash())
    .replace('__IPFS_CID__', process.env.IPFS_CID || 'not pinned');

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'index.html'), final);
  fs.writeFileSync(path.join(DIST, 'app.js'), js);
  fs.copyFileSync(path.join(SRC, 'style.css'), path.join(DIST, 'style.css'));

  // Copy static assets
  for (const asset of ['jblogo.gif', 'favicon.svg']) {
    const src = path.join(SRC, asset);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, asset));
  }

  console.log(`Built dist/index.html (${(final.length / 1024).toFixed(0)} KB), dist/app.js (${(js.length / 1024).toFixed(0)} KB)`);
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).reduce((env, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return env;
    const idx = trimmed.indexOf('=');
    if (idx === -1) return env;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim();
    env[key] = raw.replace(/^['"]|['"]$/g, '');
    return env;
  }, {});
}

function getGitHash() {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD').toString().trim();
  } catch (_) {
    return 'unknown';
  }
}

build().catch(err => {
  console.error(err);
  process.exit(1);
});
