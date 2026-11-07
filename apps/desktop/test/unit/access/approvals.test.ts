// AF-013: the approval flow – a step outside the mode waits for the person (access.requested), "Allow once" lets it
// run once, "Always for this agent" adds a rule kept in agents/<id>/access.json, "Deny", a stopped turn or the time
// limit refuse it; the mode stays per agent across a new store (a restart); a chat and a run override the mode; and the
// tool registry refuses a file write in read-only mode and waits for the dialog in ask mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApprovalBroker } from '../../../src/runtime/access/approvals.ts';
import { AccessStore, ACCESS_FILE } from '../../../src/runtime/access/store.ts';
import { AccessService } from '../../../src/runtime/access/service.ts';
import { Registry } from '../../../src/runtime/tools/registry.ts';
import { setup, tool } from '../tools/helpers.ts';
import type { AccessRequest } from '../../../src/shared/model/access.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';

function rig(options: { dataDir?: string; timeoutMs?: number } = {}) {
  const events: Array<{ event: string; data: unknown }> = [];
  const requests: AccessRequest[] = [];
  let n = 0;
  const kv = new Map<string, unknown>();
  const store = new AccessStore({
    ...(options.dataDir ? { dataDir: options.dataDir } : {}), now: () => 1,
    kv: { get: <T>(ns: string, key: string) => kv.get(`${ns}/${key}`) as T | undefined, set: (ns, key, value) => { kv.set(`${ns}/${key}`, value); }, delete: (ns, key) => kv.delete(`${ns}/${key}`) },
  });
  const broker = new ApprovalBroker({
    emit: (event: string, data: unknown) => { events.push({ event, data }); if (event === 'access.requested') requests.push(data as AccessRequest); },
    now: () => 1000 + n, id: () => `acr_test${String(++n).padStart(8, '0')}`, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  const access = new AccessService({
    store, broker, emit: (event, data) => events.push({ event, data }), workspace: () => '/home/ada/Workforce', home: () => '/home/ada/app', agentName: () => 'Tom', platform: 'linux',
  });
  /** Answers the next request as soon as it is asked. */
  const answerNext = (answer: 'once' | 'always' | 'deny') => new Promise<AccessRequest>((resolve) => {
    const timer = setInterval(() => {
      const request = requests.shift();
      if (!request) return;
      clearInterval(timer);
      assert.ok(access.answer(request.id, answer));
      resolve(request);
    }, 1);
  });
  return { access, store, broker, events, requests, answerNext };
}

const SCOPE = { agentId: 'ag_tom', conversationId: 'ch_1', runId: 'run_1' };
const WRITE = { kind: 'write' as const, path: '/home/ada/docs/a.md' };

test('no access.json: full access, nothing judged or asked (the behaviour before AF-013)', async () => {
  const { access, events } = rig();
  assert.deepEqual({ ...access.effective(SCOPE) }, { agentId: 'ag_tom', mode: 'full', agentMode: 'full', source: 'default', rules: {}, project: '/home/ada/app' });
  assert.equal(access.unlimited(SCOPE), true);
  assert.equal((await access.decide(SCOPE, [WRITE], 'tools')).allow, true);
  assert.equal(events.length, 0);
});

test('ask: the step waits for the person; once lets it run once, always adds the rule, deny refuses', async () => {
  const { access, answerNext, events } = rig();
  access.set('ag_tom', { mode: 'ask' });
  const once = access.decide(SCOPE, [WRITE], 'claude');
  const asked = await answerNext('once');
  assert.equal(asked.summary, 'Change /home/ada/docs/a.md');
  assert.equal(asked.always, 'allow changes in /home/ada/docs');
  assert.equal(asked.via, 'claude');
  assert.equal((await once).allow, true);

  const denied = access.decide(SCOPE, [WRITE], 'claude');
  await answerNext('deny');
  const refusal = await denied;
  assert.equal(refusal.allow, false);
  assert.match(refusal.message, /declined/);

  const always = access.decide(SCOPE, [WRITE], 'codex');
  await answerNext('always');
  assert.equal((await always).allow, true);
  assert.deepEqual(access.own('ag_tom').rules, { folders: { write: ['/home/ada/docs'] } });
  const before = events.filter((entry) => entry.event === 'access.requested').length;
  assert.equal((await access.decide(SCOPE, [{ kind: 'write', path: '/home/ada/docs/b.md' }], 'codex')).allow, true, 'the next one runs without asking');
  assert.equal(events.filter((entry) => entry.event === 'access.requested').length, before);
  assert.ok(events.some((entry) => entry.event === 'access.resolved'));
});

test('a stopped turn and the time limit refuse the waiting step; the same step asked twice waits once', async () => {
  const { access, broker, requests } = rig({ timeoutMs: 20 });
  access.set('ag_tom', { mode: 'ask' });
  const stop = new AbortController();
  const stopped = access.decide(SCOPE, [WRITE], 'acp', stop.signal);
  const again = access.decide(SCOPE, [WRITE], 'acp');
  assert.equal(broker.list().length, 1, 'one request for the same step');
  stop.abort();
  assert.equal((await stopped).allow, false);
  assert.equal((await again).allow, false, 'the retry shares its answer');
  requests.length = 0;
  const late = await access.decide(SCOPE, [{ kind: 'command', command: 'npm test' }], 'tools');
  assert.equal(late.allow, false);
  assert.match(late.message, /Nobody answered/);
  assert.equal(broker.list().length, 0);
});

test('read only denies without asking; deny rules hold in full access', async () => {
  const { access, requests } = rig();
  access.set('ag_tom', { mode: 'read' });
  const refused = await access.decide(SCOPE, [WRITE], 'tools');
  assert.equal(refused.allow, false);
  assert.match(refused.message, /read only/);
  assert.equal(requests.length, 0);
  access.set('ag_tom', { mode: 'full', rules: { commands: { deny: ['git push *'] } } });
  assert.equal(access.unlimited(SCOPE), false);
  assert.equal((await access.decide(SCOPE, [{ kind: 'command', command: 'git push --force' }], 'tools')).allow, false);
  assert.equal((await access.decide(SCOPE, [{ kind: 'command', command: 'git status' }], 'tools')).allow, true);
});

test('the mode is kept per agent in agents/<id>/access.json; chat and run override it', (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'af013-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  mkdirSync(path.join(dataDir, 'agents', 'ag_tom'), { recursive: true });
  const first = rig({ dataDir });
  first.access.set('ag_tom', { mode: 'project', rules: { commands: { allow: ['npm test'] } } });
  const file = path.join(dataDir, 'agents', 'ag_tom', ACCESS_FILE);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.mode, 'project');
  assert.deepEqual(saved.rules, { commands: { allow: ['npm test'] } });
  const restarted = rig({ dataDir });
  assert.equal(restarted.access.effective({ agentId: 'ag_tom' }).mode, 'project', 'a new store reads it again');
  assert.equal(restarted.access.effective({ agentId: 'ag_ada' }).mode, 'full', 'another agent keeps full access');

  restarted.access.setChatMode('ch_1', 'read');
  assert.deepEqual([restarted.access.effective({ agentId: 'ag_tom', conversationId: 'ch_1' }).mode, restarted.access.effective({ agentId: 'ag_tom', conversationId: 'ch_1' }).source], ['read', 'chat']);
  assert.equal(restarted.access.effective({ agentId: 'ag_tom', conversationId: 'ch_2' }).mode, 'project');
  restarted.access.setRunMode('run_9', 'ask');
  assert.equal(restarted.access.effective({ agentId: 'ag_tom', conversationId: 'ch_1', runId: 'run_9' }).mode, 'ask', 'the run beats the chat');
  restarted.access.setChatMode('ch_1', undefined);
  assert.equal(restarted.access.effective({ agentId: 'ag_tom', conversationId: 'ch_1' }).source, 'agent');

  writeFileSync(file, '{"mode":"sideways"}');
  assert.equal(restarted.access.effective({ agentId: 'ag_tom' }).mode, 'full', 'an unusable file counts as missing');
  assert.throws(() => restarted.access.set('ag_tom', { rules: { folders: { write: ['relative/dir'] } } }), /absolute/);
});

function registryRig(mode?: 'read' | 'ask') {
  const h = setup();
  const r = rig();
  if (mode) r.access.set('ag_tom', { mode });
  (h.services as RuntimeServices).access = r.access;
  const wrote: string[] = [];
  const registry = new Registry({ services: () => h.services as RuntimeServices });
  registry.register(tool('files.write', 'write_local', {
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run: async (args) => { wrote.push(String(args.path)); return { content: [{ type: 'text', text: 'ok' }] }; },
  }));
  const base: Omit<ToolContext, 'services'> = { agent: h.org.require('ag_tom'), runId: 'run_1', conversationId: h.chat.id, mode: 'general', signal: new AbortController().signal, status: () => {} };
  const write = (callId: string) => registry.call('files.write', { path: '/home/ada/app/notes.md', content: 'x' }, base, callId);
  return { ...r, wrote, write };
}

test('the tool registry: read only cannot write a file; ask waits for the dialog; full writes as before', async () => {
  const read = registryRig('read');
  const refused = await read.write('c1');
  assert.equal(refused.isError, true);
  assert.match(refused.content[0]!.type === 'text' ? refused.content[0]!.text : '', /My access does not allow this/);
  assert.deepEqual(read.wrote, []);

  const ask = registryRig('ask');
  const waiting = ask.write('c2');
  const request = await ask.answerNext('once');
  assert.equal(request.via, 'tools');
  assert.equal((await waiting).isError, undefined);
  assert.deepEqual(ask.wrote, ['/home/ada/app/notes.md']);

  const full = registryRig();
  assert.equal((await full.write('c3')).isError, undefined);
  assert.equal(full.requests.length, 0);
});
