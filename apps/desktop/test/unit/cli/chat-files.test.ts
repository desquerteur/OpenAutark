// B-050 in the wf terminal client: `wf export <chat…> [--dir]` resolves chats by name or id and calls
// chats.export with an absolute folder; `wf send --silent` posts quietly and is refused together with
// --important; help lists export (there is no import command any more).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { message } from './fixtures.ts';
import { fakeRuntime, launch, notes, wf } from './fake-runtime.ts';

test('export: chats by name or id, --dir made absolute; human and --json output', async (t) => {
  const runtime = await fakeRuntime({
    'chats.export': (params) => ({ dir: (params as { dir?: string }).dir ?? '/data/exports/chats-1', chats: 2, messages: 7, files: 1 }),
  });
  t.after(() => runtime.stop());
  const human = await wf(['export', 'Launch', notes.id, launch.id, '--dir', 'out'], { runtime });
  assert.equal(human.code, 0, human.err);
  const params = runtime.calls.filter((call) => call.method === 'chats.export').map((call) => call.params as { conversationIds: string[]; dir?: string });
  assert.deepEqual(params[0], { conversationIds: [launch.id, notes.id], dir: path.resolve('out') });
  assert.equal(human.out, `Exported 2 chats, 7 messages and 1 file to ${path.resolve('out')}\n`);
  const json = await wf(['export', 'Notes', '--json'], { runtime });
  assert.deepEqual(JSON.parse(json.out), { dir: '/data/exports/chats-1', chats: 2, messages: 7, files: 1 });
  assert.equal('dir' in (runtime.calls.filter((call) => call.method === 'chats.export')[1].params as object), false);
  assert.equal((await wf(['export'], { runtime })).code, 2, 'a chat is needed');
  assert.equal((await wf(['export', 'Nobody'], { runtime })).code, 4);
});

test('send --silent posts quietly; together with --important it is refused; help names export', async (t) => {
  const runtime = await fakeRuntime({ 'messages.send': () => message({ id: 'msg_quiet', seq: 3, conversationId: launch.id, body: 'fyi' }) });
  t.after(() => runtime.stop());
  const quiet = await wf(['send', 'Launch', 'fyi', '--silent'], { runtime });
  assert.equal(quiet.code, 0, quiet.err);
  const sent = runtime.calls.find((call) => call.method === 'messages.send')?.params as Record<string, unknown>;
  assert.equal(sent.silent, true);
  assert.ok(!('priority' in sent));
  const both = await wf(['send', 'Launch', 'x', '--silent', '--important'], { runtime });
  assert.deepEqual([both.code, both.err], [2, 'wf: Use either --important or --silent.\n']);
  const help = await wf(['help']);
  assert.match(help.out, /\n  export\b/);
  assert.doesNotMatch(help.out, /\n  import\b/);
});
