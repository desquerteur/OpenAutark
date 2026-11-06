---
name: web-dev-workflow
description: I read this for websites, landing pages, web apps and frontend changes. My procedure for web development tasks - reading or scaffolding the project, running the dev server in the background, checking the preview at several widths, testing, and deploying with a checklist.
metadata:
  modes:
    - web
---

# Web development workflow

## 1. Orient (existing project)
- I read `package.json` (scripts, framework, package manager by lockfile: `pnpm-lock.yaml`,
  `package-lock.json`, `yarn.lock`, `bun.lock`), `README`, `AGENTS.md`, config files.
- I find how to run, test, lint and build. The project's scripts are the way in; I add one when none fits.
- In a git repo I work on my own branch with plain git in the shell (`git switch -c wf/<task>`;
  when others work in the same repo, `git worktree add ../<repo>-<task> -b wf/<task>` gives me my
  own folder). The human's work stays intact: a branch or a stash rather than a reset.
  - I run `npm install` and the dev server inside my folder (its own port).
  - I commit in small steps, check with `git diff`, and merge back into the base (`git merge`) before I
    mark the task done; on a conflict I merge the base into my branch first and resolve. Pushing reaches
    others, so it waits until someone asks for it.
  - I stop the dev server before done and remove a worktree I added (`git worktree remove`).

## 2. Scaffold (new project)
I pick the smallest fitting stack and say why in one line:
- Static landing page / brochure site → plain HTML/CSS or Astro.
- Interactive app → Vite + React/Preact (or the stack the human already uses).
- Needs server rendering, auth, API routes → Next.js or SvelteKit.
I use the official create command (`npm create vite@latest`, `npm create astro@latest`, …)
and commit the clean scaffold before changes.

## 3. Dev server
- I start it as a **background** process (e.g. `npm run dev`), read the printed URL, and open it
  in the preview pane; a foreground server would block my turn.
- When the port is taken, I use the next free one; an unknown process on it can be someone's work.
- I stop the server when the task is done (RAM).

## 4. Build the change
- I follow existing components, tokens and naming, in small, focused edits.
- Content: real content from the human or the brief. Where testimonials, client logos or numbers
  are missing, a clearly marked placeholder serves better than an invention.
- Accessibility: semantic elements, labels, alt text, focus states, contrast ≥ 4.5:1.
- Performance: optimised images (WebP/AVIF, right size), lazy-loading below the fold, no huge
  libraries for small effects.

## 5. Check in the preview
For every changed page:
- desktop (~1280 px) and phone (~390 px) width; light and dark if supported,
- browser console: no errors or warnings I caused (`browser.console` errorsOnly; failed
  requests: `browser.network` failedOnly, `requestId` for one request's body),
- interactive parts: I click through the main flow, forms submit and validate (`browser.batch`
  fills a form in one call; `browser.wait` waits for text or a quiet network, sturdier than a fixed sleep),
- screenshots of key states for the report.

## 6. Test
- I run lint, typecheck and the test suite, and add a test for each bug fix and for new logic.
- For UI flows, an end-to-end test (Playwright) when the project has the setup.
- I build for production (`npm run build`) and preview the built output once.

## 7. Deploy
Checklist:
- [ ] build and tests pass on the exact commit
- [ ] env vars / secrets set on the host (kept out of the repo)
- [ ] domain, HTTPS, redirects (www ↔ apex)
- [ ] meta title/description, favicon, social image, `robots.txt`, sitemap
- [ ] legal pages the site needs (e.g. imprint and privacy for German sites) - content from
      the human or a generator they approve
- [ ] analytics/cookies consistent with the privacy page
After deploy I open the live URL, check main paths on phone width, and note the URL and commit.

## 8. Report
What the reader needs to trust the result: the live URL, the commit or merged branch, what was
tested (tests, widths), and anything scheduled after launch - in my own words, no fixed
format, with 1-3 screenshots as `media` blocks.

## Pitfalls
- "It builds" ≠ "it works". I look at the page.
- Hard-coded localhost URLs or secrets in client code.
- Leaving dev servers running.
- Generic template design. The brand leads; when none exists, I ask for one reference.
