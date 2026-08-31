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

const root = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 8000);

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

let manifest = {};
const manifestPath = path.join(root, '_clone-manifest.json');
if (existsSync(manifestPath)) {
  manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}

/** Keep resolved paths inside the clone: a request may not climb out with ../ */
function within(rel) {
  const abs = path.resolve(root, '.' + path.posix.resolve('/', rel));
  return abs === root || abs.startsWith(root + path.sep) ? abs : null;
}

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };

function locate(pathname, search) {
  const exact = manifest[pathname + search];               // query-addressed
  if (exact) return within(exact);
  const direct = within(decodeURIComponent(pathname));
  if (direct && isFile(direct)) return direct;
  if (direct) {
    for (const c of [direct + '.html', path.join(direct, 'index.html')]) {
      if (isFile(c)) return c;
    }
  }
  return null;
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const file = locate(u.pathname === '/' ? '/index.html' : u.pathname, u.search);
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('404 ' + u.pathname + u.search);
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  const n = Object.keys(manifest).length;
  console.log(`serving ${root}`);
  console.log(`  http://localhost:${port}/`);
  console.log(`  ${n} query-addressed URL${n === 1 ? '' : 's'} from the manifest`);
});
