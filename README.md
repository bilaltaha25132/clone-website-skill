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
compares visible text length. More text after rendering means the crawl
switches to the browser engine.

The render engine intercepts **every network response the page makes** and
writes it to disk. That's what catches webfonts, lazy images, and XHR payloads
that never appear as an attribute in the source HTML. On a test of
`https://react.dev` the render engine captured 118 assets with 0 failures,
against 20 failures in static mode — the browser sends the right headers and
referer, so origins that reject bare fetches serve normally.

## Options

```
node scripts/clone.mjs <url> [options]

  --pages N            max pages (default 50)
  --all                no page limit
  --depth N            link-following depth (default 3)
  --out DIR            output folder (default ./<hostname>-clone)
  --engine E           auto | static | render (default auto)
  --include RE         only crawl paths matching this regex
  --exclude RE         skip paths matching this regex
  --delay MS           politeness delay between pages (default 300)
  --max-asset-mb N     skip assets larger than this (default 50)
  --ignore-robots      ignore robots.txt (default: honoured)
  --no-resume          re-download instead of reusing existing files
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

Serve the folder — don't open `file://`. Relative paths that climb into
`_assets/` are blocked on the file protocol:

```bash
cd example.com-clone && python -m http.server 8000
```

## How it works

1. **Discovery** — `robots.txt` → `sitemap.xml` (recursing sitemap indexes) →
   breadth-first link crawl to `--depth`.
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
└── _assets/
    ├── example.com/...
    └── cdn.other-host.com/...
```

Assets are keyed by host, so cross-domain CDN files are preserved without
collisions. Re-running resumes: existing files are reused, so adding pages
later doesn't re-download what you already have.

## What never survives a clone

- **Forms** — they POST to the origin's backend
- **Search** — usually a hosted API (Algolia, Elastic) needing credentials
- **Auth, carts, personalisation** — server-side session state
- **Analytics and cookie consent** — frequently domain-locked
- **Streamed video** — HLS/DASH manifests point back at origin CDNs

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
