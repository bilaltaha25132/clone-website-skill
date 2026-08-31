---
name: clone-website
description: Mirror any public website to a local, offline-browsable copy — including JavaScript-rendered SPAs. Use when asked to "clone a website", "mirror a site", "download a site for offline use", "archive a page", or "save a site locally". Handles server-rendered and client-rendered sites, lazy-loaded assets, webfonts, and cross-domain CDNs.
metadata:
  author: bilal
  version: "1.0.0"
  argument-hint: <url> [--pages N] [--all] [--out DIR]
---

# Clone a website

Mirrors a site to a local folder that opens in a browser with working
navigation, styling, fonts, and images.

## Usage

```bash
node scripts/clone.mjs <url> [options]
```

Run it from this skill's directory. Common invocations:

```bash
# Sample the site (default: 50 pages, discovered via sitemap then links)
node scripts/clone.mjs https://example.com

# Whole site
node scripts/clone.mjs https://example.com --all

# Just a section, into a chosen folder
node scripts/clone.mjs https://example.com --include '^/blog' --out ./blog-copy

# Force the browser engine for a stubborn SPA
node scripts/clone.mjs https://example.com --engine render
```

## How it picks an engine

`--engine auto` (the default) fetches the raw HTML, renders the same page in
Chromium, and compares visible text length. If rendering reveals meaningfully
more content, the whole crawl switches to the browser engine.

- **static** — plain HTTP. Fast. Correct for server-rendered sites
  (WordPress, HubSpot, Rails, Next.js SSR/SSG).
- **render** — Chromium via Playwright. Loads the page, waits for network
  idle, scrolls to trigger lazy-loading, then captures the post-JavaScript
  DOM. Every network response the page makes is intercepted and saved, so
  runtime-fetched assets (webfonts, XHR JSON, lazy images) are captured too.

`--engine render` is what makes "no matter how difficult the JS" true. It is
several times slower than static — only the auto-detector or an explicit flag
turns it on.

## After it runs

Serve the folder rather than opening `file://`:

```bash
node scripts/serve.mjs <output-dir> 8000
```

Use `serve.mjs`, not `python -m http.server`, whenever the run reports
query-addressed URLs. Framework image endpoints differ only by query string
(`/_next/image?url=x&w=256`), which a conventional static server cannot tell
apart - it 404s them all. The clone writes `_clone-manifest.json` and
`serve.mjs` resolves against it.

The clone hydrates and stays interactive by default. If a site's scripts
cannot run offline - content behind an authenticated API - `--dom snapshot`
saves the post-JavaScript DOM instead, which shows the content but leaves the
page inert.

## What never survives a clone

Say so plainly rather than letting the user discover it:

- **Forms** — they POST to the origin's backend
- **Search** — usually a hosted API (Algolia, Elastic) needing credentials
- **Auth, carts, personalisation** — server-side session state
- **Analytics and consent banners** — often domain-locked
- **Streamed video** — HLS/DASH manifests point at origin CDNs

## Before republishing

A clone is fine for offline reading, archiving, migration, or design
reference. Republishing carries the original's copyright, its licensed fonts
(commercial webfonts are almost never transferable), and its trade dress. If
the user intends to redeploy a copy — especially of a competitor — flag those
three before doing the work, then follow their decision.

The crawler honours `robots.txt` by default (`--ignore-robots` to override),
identifies itself in the User-Agent, and rate-limits.
