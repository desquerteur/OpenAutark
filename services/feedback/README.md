# Workforce feedback receiver

**Replaced by B-055 (2026-10-29).** Feedback is now sealed on the sender's PC for the team's public key
(X25519 + HKDF-SHA256 + AES-256-GCM) and dropped into a write-only Google Firestore mailbox; only the team's
PC opens, stores and deletes the letters (`apps/desktop/src/runtime/feedback/`). Nothing in this folder is
used by the app, and no test runs it any more (only the unused helper `apps/desktop/test/e2e/lib/feedback-receiver.mjs`
still imports it); it stays as history.

**Discontinued local prototype, 2026-10-21. Do not deploy.** The project chose not to run an
extra hosted receiver. The steps below are historical documentation, not a pending setup task.

`POST /v1/reports` is a write-only endpoint for the desktop runtime. It accepts public or
private feedback and one PNG/JPEG/WebP screenshot up to 1 MiB. It never lists reports or
serves screenshots. There is no submitter login or repository credential in the app.

Reports and receipts are stored in a dedicated Cloudflare D1 database. A receipt says
`received` while forwarding is pending, and `sent` only after GitHub confirms an issue.
Private receipts never expose an issue URL. Idempotency survives restarts; ambiguous issue
creation is reconciled by its marker, never blindly repeated. The receiver limits new
submissions to five per minute per hashed IP and 200 per day in total.

GitHub App registration uses GitHub's official manifest flow. Only the configured owner
(`GITHUB_OWNER` in `wrangler.jsonc`) is accepted. Its private key is encrypted with a server-only AES-GCM key; no
credential is returned by a route. Install it **only** on the public feedback repository
and a separate private feedback repository. The app needs Issues write and Contents write
(to attach image files). Other repositories need no access. Image files inherit repository
privacy; private image files have no public receiver download route.

## Setup

1. Confirm the intended Cloudflare account using `npx wrangler whoami`. Do not deploy into
   an unrelated account just because it is signed in. Create a public and a private GitHub
   repository for feedback with Issues enabled and an initial main branch, and put the owner and
   both names into `vars` of `wrangler.jsonc` (`GITHUB_OWNER`, `PUBLIC_REPO`, `PRIVATE_REPO`).
2. In this directory run `npm ci`, then `node scripts/configure.mjs --account <account-id>`.
   This explicitly selected account is used for the dedicated database and Worker. The
   generated local configuration is ignored by Git. The encryption key is generated and
   passed directly to Wrangler stdin, never printed or written to source.
3. Open the returned Worker origin plus `/setup`, register the GitHub App while signed in
   as that owner, then install it on the **two feedback repositories only**. Creating these app
   access rights requires the operator's approval. No personal access token is needed.
4. Set Settings → Feedback → Feedback service to the Worker HTTPS origin. Send a private
   report, verify the issue and screenshot under the private repository, and verify that
   a non-member cannot open it. Then verify a public report in the public repository.

If GitHub is not yet configured, the service still stores reports in its private operator
inbox and returns `received`, not `sent`. The operator can inspect report rows with official
Cloudflare database tools; do not query the `config` table because it contains encrypted
credentials. Re-submit the same receipt to check delivery after setup. There is no periodic
polling or automatic retry after an uncertain GitHub write.

Tests: `npm test`; dry build: `npx wrangler deploy --dry-run --outdir .wrangler/build`.
The hosted receiver and local desktop build are separate deployment steps.

Local verification on 2026-10-21: seven receiver tests and strict typechecking pass;
desktop integration uses the actual HTTP receiver with SQLite and fixture GitHub responses.
The Worker bundle builds. Native local `workerd` fails at process startup on this Windows
machine, so neither native local D1 execution nor a live Cloudflare deployment is confirmed.
