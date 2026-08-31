# clone-website

A Claude Code skill that mirrors any public website to a local, offline-browsable
copy — including JavaScript-rendered SPAs that `wget` and `curl` can't touch.

## Install

```bash
git clone <this-repo> ~/.claude/skills/clone-website
cd ~/.claude/skills/clone-website
npm install          # pulls Playwright + Chromium
```

Then in Claude Code:

```
/clone-website https://example.com
```

Or run it directly:

```bash
node scripts/clone.mjs https://example.com --pages 50
```

## Why not just wget?

`wget --mirror` fetches raw HTML. On a client-rendered site that HTML is an
empty shell — you get a `<div id="root">` and a pile of JavaScript, and the
mirror opens as a blank page.

This skill runs two engines and picks between them automatically:

| Engine | How | Good for |
| --- | --- | --- |
| `static` | plain HTTP fetch | server-rendered sites (WordPress, HubSpot, Rails, Next.js SSR/SSG) |
| `render` | Chromium via Playwright | client-rendered SPAs, lazy-loaded media, runtime-fetched assets |

`--engine auto` (default) fetches the raw HTML, renders the same page, and
compares two signals:

1. **Visible text growth.** Much more text after rendering means the markup was
   a shell -> `render`.
2. **Scripts the markup never declares.** Modern bundlers code-split, and a
   module loader pulls the chunks in at runtime. Static mode can only fetch
   what the HTML names, so those chunks are lost. Five or more undeclared
   scripts -> `render`.

The second signal exists because the first one isn't sufficient. A
server-rendered page can score ~1.1x on text and still clone into something
broken: `attio.com` ships its hero as `style="opacity:0"` and fades it in from
a runtime-loaded chunk. Static mode saved the text, missed 35 of 71 scripts,
and the copy opened with a correct navbar above an entirely blank page. The
detector now catches that case.

The render engine intercepts **every network response the page makes** and
writes it to disk — webfonts, lazy images, code-split chunks, XHR payloads.
Cloning 20 pages of `attio.com` it saved 744 assets with **0 failures**, and
the result renders indistinguishably from the live site.

## Options

```
node scripts/clone.mjs <url> [options]

  --pages N            max pages (default 50)
  --all                no page limit
  --depth N            link-following depth (default 3)
  --out DIR            output folder (default ./<hostname>-clone)
  --engine E           auto | static | render (default auto)
  --dom MODE           source | snapshot | auto (default auto)
                       source   = server HTML; hydrates like the live site
                       snapshot = post-JS DOM; shows content but stays inert
  --include RE         only crawl paths matching this regex
  --exclude RE         skip paths matching this regex
  --delay MS           politeness delay between pages (default 300)
  --max-asset-mb N     skip assets larger than this (default 50)
  --ignore-robots      ignore robots.txt (default: honoured)
  --no-resume          re-download instead of reusing existing files
  --port N             port for the built-in server (default 8100)
  --no-serve           just write the files; do not start the server
```

### Examples

```bash
# Sample a site
node scripts/clone.mjs https://example.com

# Whole site
node scripts/clone.mjs https://example.com --all

# One section only
node scripts/clone.mjs https://example.com --include '^/blog' --out ./blog

# Skip translated pages
node scripts/clone.mjs https://example.com --all --exclude '^/(de|fr|es|zh)/'
```

## Viewing the result

When a run finishes it starts a server and prints the URL:

```
open it:   http://localhost:8100/
```

That is the whole flow - clone, then open the link. `--port N` moves it,
`--no-serve` skips it and just writes the files. To serve a clone you made
earlier:

```bash
node scripts/serve.mjs example.com-clone        # also defaults to 8100
```

`serve.mjs` is a static server that also honours query strings. Frameworks
address assets through endpoints that vary only by query
(`/_next/image?url=logo.png&w=256` vs `&w=1080`), and a conventional static
server maps one path to one file, so it 404s every one of them. The clone
records those URLs in `_clone-manifest.json` and this server answers them the
way the origin did. The run tells you whether it needs this; when nothing is
query-addressed, `python -m http.server` is fine.

## Does the JavaScript actually run?

Yes - the clone hydrates and stays interactive: menus open, carousels advance,
animations play. Three things have to line up for that, and all three are the
default.

**Same-origin assets keep the origin's paths.** A bundler resolves its
code-split chunks by original URL. Filed under `_assets/<host>/_next/...` the
runtime never matches them: every script returns 200, nothing errors, and the
page still never hydrates. Third-party hosts stay namespaced under `_assets/`.

**Those paths are written root-relative.** `_next/...` and `/_next/...` resolve
to the same file, but a runtime that looks its chunks up by literal path string
only recognises the second.

**The saved HTML is the server's, not the post-JavaScript DOM.** A snapshot of
already-hydrated markup is what React compares against its payload - it
mismatches, never attaches, and the copy looks perfect but responds to nothing.
`--dom snapshot` forces the snapshot for a site whose scripts cannot run
offline (content behind an authenticated API); `--dom source` forces the server
HTML; `auto` keeps the server's HTML whenever it already carries the content.

Measured on `attio.com`: 4161 React fiber nodes in the clone against 4168 live.


## How it works

1. **Discovery** — the site's own navigation first (breadth-first from the start
   page, shallowest paths first), then `sitemap.xml` as fill. Links are read
   from the rendered DOM as well as the HTML, because a client-rendered header
   keeps its links in the framework payload where no HTML parser will find
   them. With a page budget this is the difference between cloning `/customers`
   and `/pricing` or spending all twenty pages inside `/help/reference/...`.
2. **Capture** — each page through the chosen engine. The render engine scrolls
   the page to trigger `IntersectionObserver` lazy-loading before capturing the
   post-JavaScript DOM.
3. **Rewrite, pass 1** — every `src`/`href`/`srcset`/`url()` is resolved to an
   absolute URL and wrapped in a sentinel. Assets are queued and fetched.
4. **Rewrite, pass 2** — once every page's destination is known, sentinels are
   swapped for relative paths. Pages that weren't cloned keep their absolute
   URL, so they fall through to the live site instead of 404ing.
5. **CSS** — stylesheets are re-scanned for `url()` references, since fonts and
   background images are usually named nowhere in the HTML.

Output layout:

```
example.com-clone/
├── index.html
├── about.html
├── blog/post-name.html
├── _next/static/...              # same-origin assets, at the origin's paths
├── _clone-manifest.json          # query-addressed URLs -> local files
└── _assets/
    └── cdn.other-host.com/...    # third-party, namespaced by host
```

Same-origin assets mirror the origin's own layout, because that is what the
site's own JavaScript expects. Third-party assets are keyed by host, so
cross-domain CDN files are preserved without collisions.
later doesn't re-download what you already have.

## What never survives a clone

- **Forms** — they POST to the origin's backend
- **Search** — usually a hosted API (Algolia, Elastic) needing credentials
- **Auth, carts, personalisation** — server-side session state
- **Analytics and cookie consent** — frequently domain-locked
- **Error reporting** - Sentry and friends POST to an ingest endpoint; those
  requests fail harmlessly

A clone is a sample, so links will point at pages outside it. Rather than
dead-ending on a 404, `serve.mjs` redirects any path it does not hold to the
live site — navigation keeps working, and it is obvious which pages are local.
That does mean the copy reaches the network for those; `--pages` higher, or
`--all`, shrinks the gap.
- **Streamed video** — HLS/DASH manifests point back at origin CDNs
- **URLs inside framework payloads** — a page's own JSON blob (Next's RSC
  stream, `__NEXT_DATA__`) is left untouched, because rewriting a URL inside a
  JSON string literal corrupts the script. Anything the client re-requests from
  that payload will 404 offline. What the markup declares is already local, so
  this shows up as a handful of duplicate image requests, not missing content

## Before you republish

Cloning for offline reading, archiving, migration, or design reference is
ordinary use. Republishing is a different question, and three things travel
with the copy:

- **Copyright** in the text and images
- **Font licences** — commercial webfonts are almost never transferable, and a
  licensed `.woff2` in your repo is the usual way this goes wrong
- **Trade dress** — the risk is real when the original is a competitor in your
  market, because customer confusion is the thing the law actually protects
  against

The crawler honours `robots.txt`, identifies itself in its User-Agent, and
rate-limits by default.

## Requirements

- Node 18+
- `npm install` (Playwright + Chromium, ~150 MB) — only needed for the render
  engine; static mode runs on Node's built-in `fetch` alone
