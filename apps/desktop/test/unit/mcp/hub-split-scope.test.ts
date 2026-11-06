// B-057 S8 review fix (30.10.2026): a split's MCP lease has no chat, but its tool list must be its parent chat's – the
// learned tools there included – so a forked Claude session (--fork-session) gets exactly the parent's list. Since the
// owner's correction agents.split is no core tool; once an agent used it in a chat it is learned there, and a split of
// that chat must see it too (and tools.find must call it "in my list").
// Owns: these assertions only. Never: a real engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mcp } from '../../../src/runtime/mcp/hub.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { noteLearned, promoteLearned } from '../../../src/runtime/tools/learned.ts';
import { memoryDb } from '../store/helpers.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import type { ToolSpec } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const AGENT = { id: 'ag_tom', name: 'Tom', mode: 'general' } as Agent;
const spec = (name: string): ToolSpec => ({ name, description: `${name}.`, inputSchema: { type: 'object', properties: {} } });
const CORE = ['tools.find', 'tools.call', 'chat.send'];
const ALL = [...CORE, 'agents.split'];

test('a split\'s lease lists its parent chat\'s learned tools, like the parent\'s own lease', async () => {
  const db = memoryDb();
  const services = {
    db, clock: new ManualClock(Date.UTC(2026, 9, 30, 22)), log: new MemoryLogger(),
    host: { app: { version: '9.9.9' } },
    modes: { get: (key: string) => ({ key, name: key, description: '', skills: [], tools: ['*'], category: 'general', instructions: '' }) },
    tools: {
      specsFor: () => ALL.map(spec),
      offerFor: (_agent: unknown, _mode: unknown, _engine: unknown, learned: readonly string[] = []) => ALL.filter((name) => CORE.includes(name) || learned.includes(name)).map(spec),
    },
  } as unknown as RuntimeServices;
  noteLearned(services, AGENT.id, 'ch_1', 'agents.split'); // used through tools.call in ch_1 …
  assert.equal(promoteLearned(services, AGENT.id, 'ch_1'), true); // … and direct there from the next fresh session
  const hub = new Mcp({ services: () => services, baseUrl: () => 'http://127.0.0.1:4000/' });
  const list = async (token: string) => {
    const reply = await hub.handle(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, {});
    return (reply.body as { result: { tools: Array<{ title: string }> } }).result.tools.map((tool) => tool.title);
  };
  const parent = hub.lease({ agent: AGENT, runId: 'run_p', conversationId: 'ch_1', mode: 'general' });
  const split = hub.lease({ agent: AGENT, runId: 'run_s', mode: 'general', split: { splitId: 'spl_1', groupId: 'sgr_1', idx: 1, of: 2, parentRunId: 'run_p', parentThread: 'ch_1', parentConversationId: 'ch_1', context: 'fork' } } as never);
  const other = hub.lease({ agent: AGENT, runId: 'run_o', conversationId: 'ch_2', mode: 'general' });
  assert.deepEqual(await list(parent.token), ALL);
  assert.deepEqual(await list(split.token), await list(parent.token), 'the fork gets the parent\'s exact list');
  assert.deepEqual(await list(other.token), CORE, 'another chat has not learned it');
});
