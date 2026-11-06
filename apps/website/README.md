# Autark website

The static product website for Autark. No framework, no dependencies: one Node script writes finished HTML to `dist/`. All content is in the HTML; JavaScript only adds animations and the live version from GitHub.

## Commands (in `apps/website`)

| Command | What it does |
|---|---|
| `node build.mjs` | builds `dist/` (reads version, size and changelog from GitHub; `OFFLINE=1` skips that) |
| `SITE_URL=https://example.com node build.mjs` | builds for another address; the path of `SITE_URL` is the base path (canonical links, internal links, sitemap, llms.txt, redirects and social cards follow it) |
| `APP_URL=https://app.example.com/app node build.mjs` | sets where the hosted iPhone web app lives; the build refuses an app address that shares its origin with the site, because the app keeps the phone's key in that origin's storage |
| `node --test test/site.test.mjs` | the site's tests (an offline build into a temp folder) |
| `node scripts/render-images.mjs` | renders the PNGs again: social card, app icon, browser icons (uses Playwright's Chromium from `apps/desktop`) |
| `node scripts/qa.mjs` | checks every page on phone and desktop width: JS errors, horizontal overflow, broken internal links, exactly one h1 (needs a server on port 4321) |
| `node scripts/fetch-fonts.mjs` | downloads the fonts once (self-hosted, visitors never call Google) |

Local preview: `python -m http.server 4321 --directory dist`, then open the base path, e.g. http://127.0.0.1:4321/autark/.

## Layout

- `src/config.mjs` – the one place for name, address (`SITE_URL`), app address (`APP_URL`), release repository, platforms, fixed file links and the installed app's name.
- `src/platform.mjs` – one page per platform, `/download/<id>/`: big button, file facts, steps, checksum, updates.
- `src/pages/*.mjs` – one file per page; `src/pages/app.mjs` is the hosted iPhone web app's document, `src/pages/pair.mjs` the landing page of a "connect a phone" QR code.
- `src/app/shell.js`, `src/app/sw.js` – generated from `apps/desktop/src/ui/hosted/` by `apps/desktop/scripts/hosted-bundle.mjs`; a unit test in `apps/desktop` fails when they are stale.
- `src/data/*.mjs` – features with an honest status, FAQ, install steps.
- `src/layout.mjs` – head (meta, Open Graph, JSON-LD), header, phone menu, footer.
- `src/assets/` – styles and the small animation script (runs only while visible, honours `prefers-reduced-motion`).
- `src/brand.mjs`, `src/icons.mjs` – logo geometry and icons.

For AI crawlers the build writes `llms.txt`, `llms-full.txt`, `facts.json`, `robots.txt`, `sitemap.xml` and JSON-LD on every page.

## Download links

Release files carry no version number, so `https://github.com/teydra/OpenAutark/releases/latest/download/<file>` always gives the newest one. The site offers platform pages (`/download/windows/` …) and fixed file addresses (`/get/windows`, `/get/mac`, `/get/linux`, `/get/android`, `/get/checksums`) that redirect to the newest file.

## Hosting

`dist/` is plain static files; any static host works. `vercel.json` in `dist/` carries the redirects and headers for Vercel; other hosts get small redirect pages instead.
