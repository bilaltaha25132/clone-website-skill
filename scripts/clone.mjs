#!/usr/bin/env node
/**
 * clone.mjs — mirror a website to a local, offline-browsable copy.
 *
 * Two engines:
 *   static — plain HTTP fetch. Correct and fast for server-rendered sites.
 *   render — Chromium via Playwright. Captures the post-JavaScript DOM and
 *            intercepts every network response, so lazy-loaded images,
 *            webfonts and runtime XHR are all saved.
 *
 * `--engine auto` renders one probe page and compares visible text length
 * against the raw HTML to decide which to use for the whole crawl.
 */
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('-')) {
  console.error('usage: node clone.mjs <url> [--pages N|--all] [--out DIR] [--engine auto|static|render]');
  console.error('       [--depth N] [--include RE] [--exclude RE] [--delay MS] [--concurrency N]');
  console.error('       [--ignore-robots] [--no-resume] [--max-asset-mb N]');
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? dflt : (argv[i + 1] ?? true);
};
const has = (name) => argv.includes('--' + name);

const START = new URL(argv[0]);
const ORIGIN = START.origin;
const OPTS = {
  out: path.resolve(String(flag('out', `./${START.hostname}-clone`))),
  pages: has('all') ? Infinity : Number(flag('pages', 50)),
  depth: Number(flag('depth', 3)),
  engine: String(flag('engine', 'auto')),
  delay: Number(flag('delay', 300)),
  include: flag('include', null) ? new RegExp(String(flag('include'))) : null,
  exclude: flag('exclude', null) ? new RegExp(String(flag('exclude'))) : null,
  resume: !has('no-resume'),
  ignoreRobots: has('ignore-robots'),
  maxAsset: Number(flag('max-asset-mb', 50)) * 1024 * 1024,
};
const UA = 'Mozilla/5.0 (compatible; clone-website/1.0; +local archival copy)';

// Printable sentinel wrapping absolute URLs during pass 1, swapped for local
// relative paths in pass 2 once every page's destination file is known.
const S = '%%CLONE%%';
const MARKED = new RegExp(S + '(.*?)' + S, 'g');
const mark = (u) => S + u + S;

// ------------------------------------------------------------------- paths
const ASSET_DIR = '_assets';
const sanitize = (p) => decodeURIComponent(p)
  .replace(/[<>:"|?*\\]/g, '_')
  .split('/').filter((s) => s && s !== '.' && s !== '..')
  .map((s) => s.slice(0, 80));

function pageFile(u) {
  const url = new URL(u);
  const parts = sanitize(url.pathname);
  if (!parts.length) return path.join(OPTS.out, 'index.html');
  const last = parts[parts.length - 1];
  if (!/\.[a-z0-9]{2,5}$/i.test(last)) parts[parts.length - 1] = last + '.html';
  return path.join(OPTS.out, ...parts);
}
function assetFile(u, ct) {
  const url = new URL(u);
  const parts = sanitize(url.pathname);
  if (!parts.length) parts.push('index');
  const i = parts.length - 1;
  // An extensionless path needs one, or the static server serves it as
  // octet-stream. Content-Type wins over the URL: Next's optimizer re-encodes,
  // so `...url=logo.webp` can come back as JPEG.
  const ext = /\.[a-z0-9]{2,5}$/i.test(parts[i])
    ? ''
    : (extFromCT(ct) ?? assetExtOf(u) ?? '');
  // keep query-distinguished assets apart without breaking the extension
  if (url.search) {
    const h = [...url.search].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36);
    const m = parts[i].match(/^(.*?)(\.[a-z0-9]{2,5})$/i);
    parts[i] = m ? `${m[1]}.${h}${m[2]}` : `${parts[i]}.${h}${ext}`;
  } else {
    parts[i] += ext;
  }
  return path.join(OPTS.out, ASSET_DIR, url.hostname, ...parts);
}

/** Resume: the extension depends on a response we haven't made yet, so match on stem. */
function existingAsset(u) {
  const guess = assetFile(u);
  if (existsSync(guess)) return guess;
  const dir = path.dirname(guess);
  const stem = path.basename(guess).replace(/\.[a-z0-9]{2,5}$/i, '');
  try {
    for (const f of readdirSync(dir)) {
      if (f === stem || f.startsWith(stem + '.')) return path.join(dir, f);
    }
  } catch { /* directory not created yet */ }
  return null;
}
const relFrom = (from, to) => path.relative(path.dirname(from), to).split(path.sep).join('/');
const write = async (f, buf) => {
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, buf);
};

// ------------------------------------------------------------------ state
const pageMap = new Map();   // absolute page url -> local file
const assetMap = new Map();  // absolute asset url -> local file (null = failed)
const stats = { pages: 0, assets: 0, reused: 0, failed: 0, bytes: 0 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ASSET_EXT = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|json|xml|txt)$/i;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", '#x27': "'", nbsp: ' ' };
/** Attribute values arrive HTML-escaped; `&amp;w=256` is a parameter named "amp;w". */
const decodeEntities = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (ENTITIES[k] !== undefined) return ENTITIES[k];
    if (k[0] === '#') {
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return m;
  });

/**
 * Image CDNs serve assets from extensionless paths and name the real file in a
 * query parameter -- Next.js `/_next/image?url=...%2Flogo.png&w=256`. Look in
 * both places, and report the extension so the copy lands on disk with a name
 * the static server can assign a MIME type to.
 */
function assetExtOf(u) {
  try {
    const x = new URL(u);
    const inPath = x.pathname.match(ASSET_EXT);
    if (inPath) return inPath[0];
    for (const v of x.searchParams.values()) {
      const m = decodeURIComponent(v).split(/[?#]/)[0].match(ASSET_EXT);
      if (m) return m[0];
    }
  } catch { /* malformed */ }
  return null;
}
const looksLikeAsset = (u) => assetExtOf(u) !== null;

const CT_EXT = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg',
  'image/webp': '.webp', 'image/avif': '.avif', 'image/gif': '.gif',
  'image/svg+xml': '.svg', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js',
  'application/json': '.json', 'font/woff2': '.woff2', 'font/woff': '.woff',
  'font/ttf': '.ttf', 'font/otf': '.otf', 'application/pdf': '.pdf',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'audio/mpeg': '.mp3',
};
const extFromCT = (ct) =>
  ct ? (CT_EXT[ct.split(';')[0].trim().toLowerCase()] ?? null) : null;

const isPage = (u) => {
  try { const x = new URL(u); return x.origin === ORIGIN && !looksLikeAsset(u); }
  catch { return false; }
};
const allowedPath = (p) =>
  (!OPTS.include || OPTS.include.test(p)) && (!OPTS.exclude || !OPTS.exclude.test(p));

// ------------------------------------------------------------------ robots
let disallow = [];
async function loadRobots() {
  if (OPTS.ignoreRobots) return;
  try {
    const r = await fetch(ORIGIN + '/robots.txt', { headers: { 'User-Agent': UA } });
    if (!r.ok) return;
    const txt = await r.text();
    let applies = false;
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*)$/i);
      if (!m) continue;
      if (m[1].toLowerCase() === 'user-agent') applies = m[2].trim() === '*';
      else if (applies && m[2].trim()) disallow.push(m[2].trim());
    }
  } catch { /* no robots.txt is not an error */ }
}
const robotsOk = (u) => {
  if (OPTS.ignoreRobots) return true;
  const p = new URL(u).pathname;
  return !disallow.some((d) => p.startsWith(d.replace(/\*.*$/, '')));
};

// ---------------------------------------------------------------- discovery
async function fromSitemaps() {
  const found = new Set();
  const queue = [ORIGIN + '/sitemap.xml'];
  try {
    const r = await fetch(ORIGIN + '/robots.txt', { headers: { 'User-Agent': UA } });
    if (r.ok) {
      for (const m of (await r.text()).matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) queue.push(m[1]);
    }
  } catch { /* ignore */ }

  const seen = new Set();
  while (queue.length && found.size < 50000) {
    const sm = queue.shift();
    if (seen.has(sm)) continue;
    seen.add(sm);
    try {
      const r = await fetch(sm, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const xml = await r.text();
      const isIndex = /<sitemapindex/i.test(xml);
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
        if (isIndex) queue.push(m[1]);
        else if (isPage(m[1])) found.add(m[1].split('#')[0]);
      }
    } catch { /* skip bad sitemap */ }
  }
  return [...found];
}

function linksFrom(html, base) {
  const out = new Set();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) {
    try {
      const u = new URL(m[1], base);
      u.hash = '';
      if (isPage(u.href)) out.add(u.href);
    } catch { /* malformed href */ }
  }
  return [...out];
}

// ------------------------------------------------------------------ assets
async function saveAsset(url, buf, ct) {
  if (assetMap.has(url)) return assetMap.get(url);
  if (buf.length > OPTS.maxAsset) { assetMap.set(url, null); return null; }
  const f = assetFile(url, ct);
  await write(f, buf);
  assetMap.set(url, f);
  stats.assets++;
  stats.bytes += buf.length;
  return f;
}
async function fetchAsset(url) {
  if (assetMap.has(url)) return assetMap.get(url);
  if (OPTS.resume) {
    const hit = existingAsset(url);
    if (hit) { assetMap.set(url, hit); stats.reused++; return hit; }
  }
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: ORIGIN } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await saveAsset(url, Buffer.from(await r.arrayBuffer()), r.headers.get('content-type'));
  } catch {
    stats.failed++;
    assetMap.set(url, null);
    return null;
  }
}

// --------------------------------------------------------------- rewriting
const ATTR = /\b(src|href|poster|data-src|data-srcset|srcset)\s*=\s*(["'])(.*?)\2/gis;
const CSSURL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

const SCRIPT_BLOCK = /<script[^>]*>[\s\S]*?<\/script>/gi;

/**
 * Apply `fn` to markup only, leaving <script> bodies untouched. Framework
 * payloads (Next's RSC stream, __NEXT_DATA__) sit in those blocks as JSON
 * string literals; substituting a URL that carries a quote corrupts the script.
 */
function outsideScripts(html, fn) {
  let out = '', last = 0;
  for (const m of html.matchAll(SCRIPT_BLOCK)) {
    out += fn(html.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + fn(html.slice(last));
}

async function collectAndRewrite(html, pageUrl, { fetchMissing }) {
  const jobs = [];
  const resolve = (raw) => {
    try { return new URL(decodeEntities(raw.trim()), pageUrl).href.split('#')[0]; } catch { return null; }
  };

  let out = outsideScripts(html, (chunk) => chunk.replace(ATTR, (full, attr, q, val) => {
    const a = attr.toLowerCase();
    if (a === 'srcset' || a === 'data-srcset') {
      const parts = val.split(',').map((s) => {
        const [u, d] = s.trim().split(/\s+/, 2);
        const abs = resolve(u);
        if (!abs) return s.trim();
        jobs.push(abs);
        return mark(abs) + (d ? ' ' + d : '');
      });
      return `${attr}=${q}${parts.join(', ')}${q}`;
    }
    if (/^(data:|mailto:|tel:|javascript:|#)/i.test(val)) return full;
    const abs = resolve(val);
    if (!abs) return full;
    if (looksLikeAsset(abs)) { jobs.push(abs); return `${attr}=${q}${mark(abs)}${q}`; }
    if (isPage(abs)) return `${attr}=${q}${mark(abs)}${q}`;  // resolved in pass 2
    return `${attr}=${q}${abs}${q}`;                          // offsite: leave absolute
  }));

  out = outsideScripts(out, (chunk) => chunk.replace(CSSURL, (full, q, val) => {
    if (val.startsWith('data:')) return full;
    const abs = resolve(val);
    if (!abs) return full;
    jobs.push(abs);
    // keep the author's quoting: emitting `"` inside style="..." ends the attribute
    return `url(${q}${mark(abs)}${q})`;
  }));

  if (fetchMissing) {
    for (let i = 0; i < jobs.length; i += 6) {
      await Promise.all(jobs.slice(i, i + 6).map(fetchAsset));
    }
  }
  return out;
}

/** Pass 2: swap marked absolute URLs for local relative paths. */
async function resolveMarkers(file) {
  let txt = await fs.readFile(file, 'utf8');
  txt = txt.replace(MARKED, (_, abs) => {
    const target =
      pageMap.get(abs) ?? pageMap.get(abs.replace(/\/$/, '')) ?? assetMap.get(abs);
    return target ? relFrom(file, target) : abs;  // not cloned -> stays live
  });
  await fs.writeFile(file, txt);
}

async function rewriteCss(file, cssUrl) {
  let txt;
  try { txt = await fs.readFile(file, 'utf8'); } catch { return; }
  const jobs = [];
  const out = txt.replace(CSSURL, (full, q, val) => {
    if (val.startsWith('data:')) return full;
    let abs;
    try { abs = new URL(val.trim(), cssUrl).href.split('#')[0]; } catch { return full; }
    jobs.push(abs);
    return `url("${mark(abs)}")`;
  });
  for (let i = 0; i < jobs.length; i += 6) await Promise.all(jobs.slice(i, i + 6).map(fetchAsset));
  await fs.writeFile(file, out.replace(MARKED, (_, abs) => {
    const t = assetMap.get(abs);
    return t ? relFrom(file, t) : abs;
  }));
}

// ------------------------------------------------------------------ engines
async function fetchStatic(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.text();
}

const visibleLen = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim().length;

let browser = null;
let context = null;
let playwrightMissing = false;
async function initBrowser() {
  if (browser) return true;
  if (playwrightMissing) return false;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 } });
    return true;
  } catch (e) {
    playwrightMissing = true;
    console.error('\n  playwright unavailable — the render engine needs it:');
    console.error('    cd "' + path.dirname(new URL(import.meta.url).pathname).replace(/^\//, '') + '/.." && npm install');
    console.error('  falling back to the static engine (JS-rendered pages may come out empty)\n');
    return false;
  }
}

/** Render a page, saving every response the browser makes along the way. */
async function fetchRendered(url, seenScripts) {
  if (!(await initBrowser())) return await fetchStatic(url);
  const page = await context.newPage();
  const pending = [];
  if (seenScripts) {
    page.on('request', (req) => {
      if (req.resourceType() === 'script') seenScripts.add(req.url().split('#')[0]);
    });
  }
  page.on('response', (res) => {
    const u = res.url().split('#')[0];
    if (!/^https?:/.test(u)) return;
    const ct = res.headers()['content-type'] || '';
    let pathname;
    try { pathname = new URL(u).pathname; } catch { return; }
    if (!ASSET_EXT.test(pathname) && !/(css|javascript|font|image)/i.test(ct)) return;
    if (assetMap.has(u)) return;
    pending.push(res.body().then((b) => saveAsset(u, b, ct)).catch(() => {}));
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
  } catch {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch { /* keep what loaded */ }
  }
  // trigger lazy-loading, then let late requests settle
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(600);

  const html = await page.content();
  await Promise.allSettled(pending);
  await page.close();
  return html;
}

async function decideEngine() {
  if (OPTS.engine !== 'auto') return OPTS.engine;
  let raw = '';
  try { raw = await fetchStatic(START.href); } catch { return 'render'; }
  const rawLen = visibleLen(raw);

  // A short page is only an SPA shell if scripts are what will fill it.
  // example.com is 142 visible chars and needs no browser at all — the old
  // "short => render" rule sent every small static page down the slow path.
  const scriptCount = (raw.match(/<script\b/gi) || []).length;
  const hasMount = /<(div|main)[^>]+id=["'](root|app|__next|__nuxt)["']/i.test(raw);
  if (rawLen < 400 && (hasMount || scriptCount >= 3)) {
    console.log(`  probe: ${rawLen} chars server-side with ${scriptCount} scripts${hasMount ? ' + mount point' : ''} -> render`);
    return 'render';
  }
  if (rawLen < 400) {
    console.log(`  probe: ${rawLen} chars, ${scriptCount} scripts, no mount point -> static (small page, not a shell)`);
    return 'static';
  }

  let rendered = '';
  const runtimeScripts = new Set();
  try { rendered = await fetchRendered(START.href, runtimeScripts); } catch { return 'static'; }
  const renLen = visibleLen(rendered);
  const ratio = renLen / Math.max(rawLen, 1);

  // Scripts the HTML never names -- code-split chunks pulled in by a module
  // loader at runtime. A server-rendered page reads fine without them but
  // arrives inert: entrance animations that start at opacity:0 never run, so
  // the copy looks blank. Static mode can only fetch what the markup declares.
  const declared = new Set(
    [...raw.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)]
      .map((m) => { try { return new URL(m[1], START.href).href; } catch { return m[1]; } }),
  );
  const undeclared = [...runtimeScripts].filter((u) => !declared.has(u)).length;

  console.log(`  probe: static ${rawLen} vs rendered ${renLen} chars (x${ratio.toFixed(2)}), `
    + `${undeclared} runtime-loaded script${undeclared === 1 ? '' : 's'}`);

  if (ratio > 1.5) return 'render';
  if (undeclared >= 5) {
    console.log(`  -> render (markup declares ${declared.size} scripts, the page loads ${runtimeScripts.size})`);
    return 'render';
  }
  return 'static';
}

// -------------------------------------------------------------------- main
async function main() {
  console.log(`\ncloning ${START.href}`);
  console.log(`  output ${OPTS.out}`);
  await loadRobots();
  if (disallow.length) console.log(`  robots.txt: ${disallow.length} disallow rules honoured`);

  const engine = await decideEngine();
  console.log(`  engine ${engine}${OPTS.engine === 'auto' ? ' (auto)' : ''}\n`);
  const load = engine === 'render' ? fetchRendered : fetchStatic;
  if (engine === 'render') await initBrowser();

  const sm = await fromSitemaps();
  if (sm.length) console.log(`  sitemap: ${sm.length} urls\n`);

  const frontier = [{ url: START.href, d: 0 }];
  for (const u of sm) frontier.push({ url: u, d: 1 });
  const queued = new Set(frontier.map((f) => f.url));
  const done = new Set();

  while (frontier.length && stats.pages < OPTS.pages) {
    const { url, d } = frontier.shift();
    if (done.has(url)) continue;
    done.add(url);
    const p = new URL(url).pathname;
    if (!allowedPath(p) || !robotsOk(url)) continue;

    const outFile = pageFile(url);
    pageMap.set(url, outFile);
    pageMap.set(url.replace(/\/$/, ''), outFile);

    if (OPTS.resume && existsSync(outFile)) {
      stats.pages++;
      console.log(`  [${String(stats.pages).padStart(3)}] reuse  ${p}`);
      if (d < OPTS.depth) {
        for (const l of linksFrom(await fs.readFile(outFile, 'utf8'), url)) {
          if (!queued.has(l)) { queued.add(l); frontier.push({ url: l, d: d + 1 }); }
        }
      }
      continue;
    }

    let html;
    try { html = await load(url); }
    catch (e) { stats.failed++; console.log(`        FAIL   ${p} (${e.message})`); continue; }

    const rewritten = await collectAndRewrite(html, url, { fetchMissing: engine !== 'render' });
    await write(outFile, rewritten);
    stats.pages++;
    console.log(`  [${String(stats.pages).padStart(3)}] ${engine === 'render' ? 'render' : 'fetch '} ${p}  (${(stats.bytes / 1048576).toFixed(0)} MB)`);

    if (d < OPTS.depth) {
      for (const l of linksFrom(html, url)) {
        if (!queued.has(l) && allowedPath(new URL(l).pathname)) {
          queued.add(l); frontier.push({ url: l, d: d + 1 });
        }
      }
    }
    if (OPTS.delay) await sleep(OPTS.delay);
  }

  // CSS often references fonts and images the HTML never mentions
  console.log('\n  resolving css references...');
  for (const [u, f] of [...assetMap]) {
    if (f && f.endsWith('.css')) await rewriteCss(f, u);
  }

  console.log('  linking pages...');
  for (const f of new Set(pageMap.values())) {
    try { await resolveMarkers(f); } catch { /* file may not exist if skipped */ }
  }

  if (browser) await browser.close();

  console.log('\n' + '='.repeat(64));
  console.log(`pages   ${stats.pages}`);
  console.log(`assets  ${stats.assets} saved, ${stats.reused} reused, ${stats.failed} failed`);
  console.log(`size    ${(stats.bytes / 1048576).toFixed(1)} MB`);
  console.log(`output  ${OPTS.out}`);
  console.log(`\nserve it:  cd "${OPTS.out}" && python -m http.server 8000`);
}

main().catch(async (e) => {
  if (browser) await browser.close();
  console.error(e);
  process.exit(1);
});
