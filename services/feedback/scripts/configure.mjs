// Owns: provisioning this receiver in an explicitly selected Cloudflare account using Wrangler.
// Never: reads stored provider credentials, prints key values, selects a paid plan or deploys implicitly.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const account = process.argv[process.argv.indexOf('--account') + 1];
if (!process.argv.includes('--account') || !/^[a-f0-9]{32}$/.test(account ?? '')) throw new Error('Pass --account with the Cloudflare account you explicitly selected.');
const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const local = path.join(root, 'wrangler.local.jsonc');
const base = JSON.parse(readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'));
base.account_id = account;
writeFileSync(local, JSON.stringify(base, null, 2));
function wrangler(args, input) {
  const result = spawnSync(process.execPath, [cli, ...args, '--config', local], {
    cwd: root, input, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
    timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed; check account access using wrangler whoami.`);
  return result.stdout;
}
const databases = JSON.parse(wrangler(['d1', 'list', '--json']));
let database = databases.find((item) => item.name === 'workforce-feedback');
if (!database) {
  wrangler(['d1', 'create', 'workforce-feedback', '--jurisdiction', 'eu', '--update-config=false']);
  database = JSON.parse(wrangler(['d1', 'list', '--json'])).find((item) => item.name === 'workforce-feedback');
}
if (!database) throw new Error('Database creation was not confirmed. Inspect wrangler d1 list.');
const id = database.uuid ?? database.database_id;
if (typeof id !== 'string') throw new Error('Database was not confirmed; inspect wrangler d1 list before retrying.');
base.d1_databases = [{ binding: 'DB', database_name: 'workforce-feedback', database_id: id, jurisdiction: 'eu' }];
writeFileSync(local, JSON.stringify(base, null, 2));
wrangler(['d1', 'execute', 'workforce-feedback', '--remote', '--file', 'schema.sql', '--yes']);
const deployment = wrangler(['deploy']);
const secrets = JSON.parse(wrangler(['secret', 'list']));
if (!secrets.some((entry) => entry.name === 'APP_ENCRYPTION_KEY')) wrangler(['secret', 'put', 'APP_ENCRYPTION_KEY'], randomBytes(32).toString('base64') + '\n');
const origin = deployment.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
console.log(origin ? `Receiver deployed: ${origin}\nGitHub setup: ${origin}/setup` : 'Worker deployment completed. Get its origin from wrangler deployments list.');
