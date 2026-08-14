import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import {
  injectProjectPreviewMeta,
  loadProjectPreview,
  parseProjectReference,
  renderProjectPreviewPng,
} from '../src/project-preview-server.mjs';

const root = resolve('dist');
const port = Number(process.env.PORT || 3000);
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function requestOrigin(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'https' ? 'https' : 'http';
  const host = String(request.headers.host || `127.0.0.1:${port}`);
  return /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(host)
    ? `${protocol}://${host}`
    : `http://127.0.0.1:${port}`;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', 'http://localhost');
    const projectReference = parseProjectReference(url.searchParams.get('project'));
    if (url.pathname === '/project-og.png') {
      if (!projectReference) throw new Error('invalid project preview');
      const preview = await loadProjectPreview(projectReference);
      if (!preview) throw new Error('project not found');
      const image = await renderProjectPreviewPng(preview);
      response.writeHead(200, {
        'cache-control': 'public, max-age=300, s-maxage=300',
        'content-length': image.byteLength,
        'content-type': 'image/png',
        'x-content-type-options': 'nosniff',
      });
      response.end(image);
      return;
    }
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const file = resolve(join(root, relative));
    if (file !== root && !file.startsWith(root + sep)) throw new Error('outside dist');
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    let body = await readFile(file);
    if (projectReference && relative === 'index.html') {
      const preview = await loadProjectPreview(projectReference).catch(() => null);
      if (preview) {
        const origin = requestOrigin(request);
        const pageUrl = new URL('/?project=' + encodeURIComponent(projectReference.key), origin).href;
        const imageUrl = new URL(
          '/project-og.png?project=' + encodeURIComponent(projectReference.key),
          origin,
        ).href;
        body = Buffer.from(
          injectProjectPreviewMeta(body.toString('utf8'), preview, { pageUrl, imageUrl }),
        );
      }
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': contentTypes[extname(file)] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving dist at http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
