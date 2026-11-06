// CTX3: mode knowledge areas (scope 'mode', scopeId = mode key). Acceptance: a video experience
// reaches another video agent, not a web agent. Also: every agent reads a mode area (ACL and the
// vector index's mirror), mode items are never pinned,
// knowledge.remember (the run's own mode area only) and recall with scope 'mode', and the RPC checks.
// Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { fixture, VIDEO_MODE, type FixtureOptions } from '../context/fixture.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { memoryTools } from '../../../src/runtime/tools/builtin/memory.ts';
import { HandlerTable, type HandlerContext } from '../../../src/runtime/rpc/table.ts';
import { register } from '../../../src/runtime/rpc/handlers/knowledge.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { KnowledgeItem, ModeInfo } from '../../../src/shared/model/knowledge.ts';
import type { Agent, Space } from '../../../src/shared/model/org.ts';

const WEB_MODE: ModeInfo = { ...GENERAL_MODE, key: 'web', name: 'Web', category: 'frontend-ui', instructions: '# Web mode' };
const MODES = new Map([GENERAL_MODE, VIDEO_MODE, WEB_MODE].map((mode) => [mode.key, mode]));
const SPACES: Space[] = [
  { id: 'sp_co', name: 'Company', kind: 'company', sort: 0, createdAt: 0 }, { id: 'sp_home', name: 'Private', kind: 'private', sort: 1, createdAt: 0 },
  { id: 'sp_brand', name: 'Personal brand', kind: 'brand', sort: 2, createdAt: 0 },
];

/** The context fixture with video and web modes (unknown keys → general, like the mode library) and a private space. */
function world(options: FixtureOptions = {}) {
  const f = fixture(options);
  Object.assign(f.services, { modes: { get: (key: string) => MODES.get(key) ?? GENERAL_MODE, list: () => [...MODES.values()] } });
  (f.org as unknown as { spaces(): Space[] }).spaces = () => SPACES;
  const vera = f.org.add(agent('ag_vera', 'Vera', { role: 'Video editor', mode: 'video' }));
  const wes = f.org.add(agent('ag_wes', 'Wes', { role: 'Web developer', mode: 'web' }));
  return { ...f, vera, wes };
}
type World = ReturnType<typeof world>;

test('ACL: every agent reads mode areas – any space, a private space, no space', async () => {
  const f = world();
  const now = f.clock.now();
  for (const space of SPACES) f.db.run('INSERT INTO spaces (id, name, kind, created_at) VALUES (?, ?, ?, ?)', [space.id, space.name, space.kind, now]);
  for (const [id, space] of [['ag_co', 'sp_co'], ['ag_home', 'sp_home'], ['ag_none', null]] as const) {
    f.db.run(`INSERT INTO agents (id, name, avatar, space_id, created_by, created_at, updated_at) VALUES (?, ?, '{}', ?, 'human', ?, ?)`, [id, id, space, now, now]);
  }
  const item = f.knowledge.save({ title: 'Encoder choice', body: 'The hardware encoder crashes on long exports.', scope: 'mode', scopeId: 'video', kind: 'experience', createdBy: 'ag_co', pinned: true });
  f.knowledge.save({ title: 'Company encoder licence', body: 'The encoder licence belongs to the company.', scope: 'space', scopeId: 'sp_co', createdBy: 'human' });
  for (const agentId of ['ag_co', 'ag_home', 'ag_none', undefined]) {
    const visible = (await f.knowledge.search({ text: '', agentId, limit: 20 })).map((hit) => hit.item.id);
    assert.ok(visible.includes(item.id), `${agentId ?? 'the person'} reads the video area`);
    assert.ok((await f.knowledge.search({ text: 'encoder crashes', agentId })).some((hit) => hit.item.id === item.id));
  }
  assert.equal((await f.knowledge.search({ text: '', agentId: 'ag_none' })).filter((hit) => hit.item.scope === 'space').length, 0, 'spaces stay their own');

  assert.throws(() => f.knowledge.save({ title: 'No area', body: 'Missing key.', scope: 'mode', createdBy: 'human' }), /needs a scopeId/);
});

const tool = (name: string) => memoryTools.find((item) => item.name === name)!;
const ctxOf = (f: World, who: Agent, mode: string): ToolContext => ({ agent: who, runId: 'run_mem', mode, services: f.services, signal: new AbortController().signal, status: () => {} });
const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

test('knowledge.remember writes the run\'s own mode area; recall marks it', async () => {
  const f = world();
  const saved = await tool('knowledge.remember').run({ title: 'Render preset', body: 'Render course videos with the H.264 high preset.', kind: 'procedure', scope: 'mode' }, ctxOf(f, f.vera, 'video'));
  assert.equal(saved.isError, undefined, textOf(saved));
  const item = f.knowledge.get((saved.structured as { id: string }).id)!;
  assert.deepEqual([item.scope, item.scopeId, item.createdBy], ['mode', 'video', f.vera.id]);
  const named = await tool('knowledge.remember').run({ title: 'Cut list', body: 'Keep the cut list next to the project file.', scope: 'mode', scopeId: 'video' }, ctxOf(f, f.vera, 'video'));
  assert.equal(f.knowledge.get((named.structured as { id: string }).id)!.scopeId, 'video', 'the own mode may be named');


  const recall = textOf(await tool('knowledge.recall').run({ query: 'render preset for course videos' }, ctxOf(f, f.wes, 'web')));
  assert.ok(recall.includes(`- [${item.id}] Render preset: `) && recall.includes('[video mode]'), recall);
});

