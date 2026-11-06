// LIVE (opt-in): the installed Codex app-server takes no MCP server from a workspace's
// `.codex/config.toml` for a thread opened the way the engine opens it (isolation.ts: read-only,
// the cwd untrusted in the session config and the project root), saves no trust for that folder,
// and the session marks also win over trust a home already holds (an older build saved it). Also:
// no `.codex/` layer from a trusted parent repository, no trust inherited through a planted `.git`
// worktree pointer, and no layer from the server process's own folder reaches a thread. Control
// threads opened the old way show each mechanism (diagnostics only). Only thread/start and
// config/read are sent – no turn, no model call, no sign-in: each case runs in its own empty
// CODEX_HOME under test-results/. The planted "MCP server" is node writing a marker file.
// Owns: nothing in production. Never reads a real account home or sends a turn.
//   WORKFORCE_LIVE=1 node --test test/live/codex-project-config.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexServer } from '../../src/runtime/engines/codex/server.ts';
import { threadIsolation, trustKeys } from '../../src/runtime/engines/codex/isolation.ts';
import type { RpcClient } from '../../src/runtime/engines/codex/rpc.ts';
import { Supervisor } from '../../src/runtime/system/supervisor.ts';
import { ExecutableFinder } from '../../src/runtime/accounts/executables.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const live = process.env.WORKFORCE_LIVE === '1';
const skip = live ? false : 'set WORKFORCE_LIVE=1';
/** MCP servers start with the thread; give the planted one this long to show up. */
const SETTLE_MS = 8_000;

interface Case { home: string; workspace: string; marker: string }
type Diagnose = { diagnostic(message: string): void };

/** `<folder>/.codex/config.toml` with an "MCP server" that writes `marker` when it starts. */
async function plantMcp(folder: string, marker: string): Promise<void> {
  await mkdir(path.join(folder, '.codex'), { recursive: true });
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000);`;
  await writeFile(path.join(folder, '.codex', 'config.toml'), `[mcp_servers.workforce_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ["-e", ${JSON.stringify(script)}]\n`);
}

/** A case folder: an empty probe home, a workspace (planted unless `bare`), the marker path. */
async function plant(base: string, name: string, bare = false): Promise<Case> {
  const dir = path.join(base, name);
  const home = path.join(dir, 'codex-home');
  const workspace = path.join(dir, 'Workforce');
  const marker = path.join(dir, 'mcp-started.txt');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  if (!bare) await plantMcp(workspace, marker);
  return { home, workspace, marker };
}

const keysOf = async (folder: string) => trustKeys(folder, await realpath(folder).catch(() => undefined));
const isolation = async (c: Case) => threadIsolation(await keysOf(c.workspace));

/** The probe home trusts `folders` under every spelling (as an older build or the person may have saved it). */
async function trust(home: string, folders: string[]): Promise<void> {
  const keys = (await Promise.all(folders.map(keysOf))).flat();
  await writeFile(path.join(home, 'config.toml'), keys.map((key) => `[projects.${JSON.stringify(key)}]\ntrust_level = "trusted"\n`).join('\n'));
}

/** config/read's project layers (as seen from `cwd`, else the server's own folder), for diagnostics. */
async function projectLayers(rpc: RpcClient, cwd?: string): Promise<string> {
  const read = await rpc.request<{ layers?: Array<{ name?: { type?: string; dotCodexFolder?: string }; disabledReason?: string | null }> }>('config/read', { includeLayers: true, ...(cwd ? { cwd } : {}) }, 30_000).catch((error) => ({ layers: undefined, error }));
  const layers = (read.layers ?? []).filter((layer) => layer.name?.type === 'project');
  return layers.map((layer) => `${layer.name?.dotCodexFolder} ${layer.disabledReason ? `disabled (${layer.disabledReason})` : 'ENABLED'}`).join('; ') || 'none';
}

async function openThread(c: Case, serverCwd: string, settings: Record<string, unknown>, t: Diagnose, label: string): Promise<void> {
  const executable = await new ExecutableFinder().find('codex');
  assert.ok(executable, 'Codex is installed');
  const supervisor = new Supervisor({});
  const server = new CodexServer({ key: 'live_probe', home: c.home, executable, supervisor, cwd: serverCwd, version: '0.0.0-probe' });
  try {
    const rpc = await server.rpc();
    const started = await rpc.request<{ thread?: { id?: string } }>('thread/start', { cwd: c.workspace, approvalPolicy: 'on-request', ...settings }, 60_000);
    t.diagnostic(`${label}: thread/start answered: ${Boolean(started?.thread?.id)}`);
    t.diagnostic(`${label}: project layers of the server's own config: ${await projectLayers(rpc)}; seen from the workspace: ${await projectLayers(rpc, c.workspace)}`);
    await delay(SETTLE_MS);
  } finally {
    await server.dispose();
    await supervisor.killAll();
  }
}

async function trustSaved(home: string): Promise<boolean> {
  const file = path.join(home, 'config.toml'); // our own probe home: no credentials in it
  if (!existsSync(file)) return false;
  return /trust_level\s*=\s*"trusted"/.test(await readFile(file, 'utf8'));
}

async function probeBase(name: string): Promise<{ base: string; neutral: string }> {
  const base = path.join(root, 'test-results', `codex-${name}-${Date.now()}`);
  const neutral = path.join(base, 'engine-cwd');
  await mkdir(neutral, { recursive: true });
  return { base, neutral };
}

test('codex project config: an isolated thread starts no planted MCP server, saves no trust and outranks saved trust (opt-in probe)', { skip, timeout: 120_000 }, async (t) => {
  const { base, neutral } = await probeBase('project-probe');
  const isolated = await plant(base, 'isolated');
  await openThread(isolated, neutral, await isolation(isolated), t, 'isolated');
  const isolatedStarted = existsSync(isolated.marker);
  const isolatedTrusted = await trustSaved(isolated.home);

  const pretrusted = await plant(base, 'pretrusted');
  await trust(pretrusted.home, [pretrusted.workspace]);
  await openThread(pretrusted, neutral, await isolation(pretrusted), t, 'pretrusted');
  const pretrustedStarted = existsSync(pretrusted.marker);

  const control = await plant(base, 'control');
  await openThread(control, neutral, { sandbox: 'workspace-write' }, t, 'control');
  t.diagnostic(`control (old settings): planted MCP server started=${existsSync(control.marker)}, trust saved=${await trustSaved(control.home)}`);

  assert.equal(isolatedStarted, false, 'the planted MCP server never started for the isolated thread');
  assert.equal(isolatedTrusted, false, 'no trust was saved for the workspace');
  assert.equal(pretrustedStarted, false, 'the session marks win over trust the home already held');
});

test('codex project config: no layer from a trusted parent repository and no trust through a planted worktree pointer (opt-in probe)', { skip, timeout: 120_000 }, async (t) => {
  const { base, neutral } = await probeBase('parent-probe');
  // (a) The workspace lies in a repository the person trusts, whose own .codex/ starts an MCP server.
  const parent = await plant(base, 'parent', true);
  const repo = path.join(path.dirname(parent.workspace), 'repo');
  const inRepo: Case = { ...parent, workspace: path.join(repo, 'Workforce') };
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await mkdir(inRepo.workspace, { recursive: true });
  await plantMcp(repo, parent.marker);
  await trust(parent.home, [repo]);
  await openThread(inRepo, neutral, await isolation(inRepo), t, 'parent');
  const parentStarted = existsSync(parent.marker);
  const parentControl: Case = { ...inRepo, marker: path.join(path.dirname(parent.marker), 'control-started.txt') };
  await plantMcp(repo, parentControl.marker);
  const marked = await isolation(inRepo);
  await openThread(parentControl, neutral, { ...marked, config: { ...marked.config, project_root_markers: ['.git'] } }, t, 'parent control');
  t.diagnostic(`parent control (default root markers): the parent's MCP server started=${existsSync(parentControl.marker)}`);

  // (b) An agent plants <workspace>/.git as a worktree pointer into a repository the home trusts.
  const worktree = await plant(base, 'worktree');
  const trusted = path.join(path.dirname(worktree.workspace), 'trusted-repo');
  await mkdir(path.join(trusted, '.git', 'worktrees', 'wf'), { recursive: true });
  await writeFile(path.join(worktree.workspace, '.git'), `gitdir: ${path.join(trusted, '.git', 'worktrees', 'wf')}\n`);
  await trust(worktree.home, [trusted]);
  await openThread(worktree, neutral, await isolation(worktree), t, 'worktree');
  const worktreeStarted = existsSync(worktree.marker);
  const worktreeControl = await plant(base, 'worktree-control');
  await writeFile(path.join(worktreeControl.workspace, '.git'), `gitdir: ${path.join(trusted, '.git', 'worktrees', 'wf')}\n`);
  await trust(worktreeControl.home, [trusted]);
  await openThread(worktreeControl, neutral, { sandbox: 'read-only' }, t, 'worktree control');
  t.diagnostic(`worktree control (no marks): the workspace's MCP server started=${existsSync(worktreeControl.marker)}`);

  assert.equal(parentStarted, false, "a trusted parent repository's .codex/ never reaches the thread");
  assert.equal(worktreeStarted, false, 'a planted worktree pointer does not make the workspace trusted');
});

test("codex project config: a thread takes nothing from the server process's own folder (opt-in probe)", { skip, timeout: 60_000 }, async (t) => {
  const { base } = await probeBase('server-folder-probe');
  // The old layout: the server ran in temp, which helper turns could write and earlier threads trusted.
  const c = await plant(base, 'server-folder', true);
  const serverFolder = path.join(path.dirname(c.workspace), 'tmp');
  await plantMcp(serverFolder, c.marker);
  await trust(c.home, [serverFolder]);
  await openThread(c, serverFolder, await isolation(c), t, 'server folder');
  assert.equal(existsSync(c.marker), false, "the server folder's MCP server never starts for a workspace thread");
});
