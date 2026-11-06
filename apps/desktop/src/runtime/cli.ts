// Headless runtime (bundled to app/runtime-cli.mjs): worker PCs without the desktop app,
// development and end-to-end tests.
//   node app/runtime-cli.mjs --data <dir> [--workspace <dir>] [--resources <dir>] [--ui <dir>] [--port <n>] [--peer lan|tailscale|off] [--fake] [--log]
// --workspace (or WORKFORCE_WORKSPACE): the agents' files; default ~/Workforce, but <data>/workspace with
// --fake, so tests and demos never write into the person's real workspace.
// --peer: where linked PCs may reach this PC (default settings.devices.peer, 'lan'); not saved.
// Prints one JSON line {port, token} on stdout when ready (also written to <data>/runtime.json).
// Owns: argument parsing, the node host and signal handling. Never: runs without a data dir.

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeHost } from './host-node.ts';
import { createRuntime } from './main.ts';

declare const __APP_VERSION__: string | undefined;

type PeerMode = 'lan' | 'tailscale' | 'off';
const PEER_MODES: readonly string[] = ['lan', 'tailscale', 'off'];
const USAGE = 'usage: runtime-cli --data <dir> [--workspace <dir>] [--resources <dir>] [--ui <dir>] [--port <n>] [--peer lan|tailscale|off] [--fake] [--log]';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = arg('data');
  const peer = arg('peer');
  if (!dataDir || (process.argv.includes('--peer') && !PEER_MODES.includes(peer ?? ''))) {
    console.error(USAGE);
    process.exit(2);
  }
  const here = path.dirname(fileURLToPath(import.meta.url)); // app/ when bundled
  const appRoot = path.resolve(here, '..');
  const resourcesDir = path.resolve(arg('resources') ?? path.join(appRoot, 'resources'));
  const staticDir = path.resolve(arg('ui') ?? path.join(appRoot, 'app', 'ui'));
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  const token = process.env.WORKFORCE_TOKEN || randomBytes(32).toString('hex');
  const fake = process.argv.includes('--fake');
  const workspace = arg('workspace') ?? process.env.WORKFORCE_WORKSPACE ?? (fake ? path.join(dataDir, 'workspace') : undefined);
  const host = createNodeHost({ dataDir: path.resolve(dataDir), resourcesDir, version, onNotify: (input) => console.error(`[notify] ${input.title}: ${input.body}`) });
  const runtime = await createRuntime({
    host, dataDir: path.resolve(dataDir), resourcesDir, staticDir, launchToken: token, version,
    workspaceDir: workspace ? path.resolve(workspace) : undefined,
    fakeEngine: fake, port: arg('port') ? Number(arg('port')) : undefined,
    peer: peer as PeerMode | undefined, consoleLog: process.argv.includes('--log'),
  });
  process.stdout.write(`${JSON.stringify({ port: runtime.port, token })}\n`);
  const stop = () => { void runtime.shutdown('signal').finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error) => {
  console.error('runtime failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
