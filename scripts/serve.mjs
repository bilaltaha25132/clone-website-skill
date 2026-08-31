#!/usr/bin/env node
/**
 * serve.mjs — serve a cloned site the way its origin did.
 *
 * A plain static server maps one URL path to one file, which is wrong for the
 * image and asset endpoints frameworks rely on: /_next/image?url=x&w=256 and
 * ...&w=1080 share a path and differ only by query. The clone records those in
 * _clone-manifest.json; this server consults it, so a hydrated page requesting
 * the original URL gets the file the origin would have returned.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PORT = 8100;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};


/** Keep resolved paths inside the clone: a request may not climb out with ../ */
function within(root, rel) {
  const abs = path.resolve(root, '.' + path.posix.resolve('/', rel));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Shown for a path this copy does not hold. Entirely local, no outbound links. */
function missingPage(pathname, pages, origin) {
  const list = Object.keys(pages).sort();
  const items = list.length
    ? `<ul>${list.map((p) => `<li><a href="${esc(p)}">${esc(p)}</a></li>`).join('')}</ul>`
    : '<p class="dim">This copy records no page index.</p>';
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not in this copy - ${esc(pathname)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; padding:3rem 1.5rem; font:15px/1.6 ui-sans-serif,system-ui,sans-serif;
         background:#fbfbfa; color:#1a1a1a; }
  main { max-width:44rem; margin:0 auto; }
  code { background:#0000000d; padding:.15em .4em; border-radius:4px; font-size:.92em; }
  h1 { font-size:1.35rem; margin:0 0 .6rem; letter-spacing:-.01em; }
  p { margin:.5rem 0 1.4rem; }
  .dim { color:#6b6b6b; }
  ul { columns:2; gap:2rem; list-style:none; padding:0; margin:0; }
  li { break-inside:avoid; margin:.18rem 0; }
  a { color:#2f5fd0; text-decoration:none; }
  a:hover { text-decoration:underline; }
  hr { border:0; border-top:1px solid #0000001a; margin:2rem 0 1.4rem; }
  @media (prefers-color-scheme: dark) {
    body { background:#141414; color:#e8e8e8; }
    code { background:#ffffff14; }
    .dim { color:#9a9a9a; }
    a { color:#8ab4ff; }
    hr { border-top-color:#ffffff1f; }
  }
</style>
<main>
  <h1>Not in this copy</h1>
  <p><code>${esc(pathname)}</code> exists on ${esc(origin ?? 'the original site')},
     but was not part of this clone. Re-run with a higher <code>--pages</code>,
     or <code>--all</code>, to include it.</p>
  <hr>
  <p class="dim">${list.length} page${list.length === 1 ? '' : 's'} in this copy:</p>
  ${items}
</main>`;
}

function locate(root, manifest, pathname, search) {
  const exact = manifest[pathname + search];               // query-addressed
  if (exact) return within(root, exact);
  const direct = within(root, decodeURIComponent(pathname));
  if (direct && isFile(direct)) return direct;
  if (direct) {
    for (const c of [direct + '.html', path.join(direct, 'index.html')]) {
      if (isFile(c)) return c;
    }
  }
  return null;
}

/**
 * Start the server. Resolves once listening, or rejects with a readable
 * message when the port is taken -- the common case being a previous clone
 * still serving on it.
 */
export async function startServer(dir, port = DEFAULT_PORT) {
  const root = path.resolve(dir);
  let manifest = {}, origin = null, pages = {};
  const mf = path.join(root, '_clone-manifest.json');
  if (existsSync(mf)) {
    const raw = JSON.parse(await fs.readFile(mf, 'utf8'));
    // { origin, urls, pages } since those were added; older clones are a bare map
    manifest = raw.urls ?? raw;
    origin = raw.origin ?? null;
    pages = raw.pages ?? {};
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const file = locate(root, manifest, u.pathname === '/' ? '/index.html' : u.pathname, u.search);
    if (!file) {
      // Outside the crawl budget. Stay local and say so -- never bounce the
      // visitor onto the live site, which would quietly stop being a clone.
      if (req.headers.accept?.includes('text/html')) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(missingPage(u.pathname, pages, origin));
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('404 ' + u.pathname + u.search);
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(file).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', (e) => reject(
      e.code === 'EADDRINUSE'
        ? new Error(`port ${port} is already in use - stop whatever holds it, `
                  + `or pass --port <n>`)
        : e,
    ));
    server.listen(port, resolve);
  });
  return { server, port, mapped: Object.keys(manifest).length };
}

// Run standalone: node serve.mjs <dir> [port]
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { port, mapped } = await startServer(process.argv[2] ?? '.',
    Number(process.argv[3] ?? DEFAULT_PORT));
  console.log(`serving ${path.resolve(process.argv[2] ?? '.')}`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  ${mapped} query-addressed URL${mapped === 1 ? '' : 's'} from the manifest`);
}
