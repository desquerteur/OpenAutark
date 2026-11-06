// B-048 E1: a tool output over 4,000 characters is kept whole in a blob the journal row names (data.outputBlob,
// data.outputChars) – ours through tools/journal.ts (which now hands the whole text), engine-native as a string;
// the row and its preview stay as before; an output the registry stored already (blobIds) and a short one are
// not stored again; a failed blob write never fails the item.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';
import { clock, memoryDb, recordingBus } from '../store/helpers.ts';

function setup(keep: (text: string, name: string) => Promise<string | undefined>) {
  const db = memoryDb();
  const recorder = recordingBus();
  const warnings: string[] = [];
  const journal = new Journal({ db, bus: recorder.bus, clock: clock(), keepOutput: keep, log: { debug() {}, info() {}, warn: (message: string) => { warnings.push(message); }, error() {} } });
  journal.start({ id: 'run_1', agentId: 'ag_1', conversationId: 'ch_1', trigger: 'message' });
  return { db, journal, warnings, ...recorder };
}

const BLOB = 'a'.repeat(64);

test('engine-native output over 4,000 chars: kept whole, the row names the blob and the full length', async () => {
  const kept: Array<{ text: string; name: string }> = [];
  const { journal, of } = setup(async (text, name) => { kept.push({ text, name }); return BLOB; });
  const output = 'line\n'.repeat(2_000);
  const item = journal.item('run_1', { kind: 'tool_result', data: { callId: 'c1', ok: true, summary: 'exit 0', output }, effectStatus: 'none' });
  assert.ok((item.data.output as string).length < 4_100, 'the row stays truncated');
  assert.equal(item.data.outputChars, 10_000);
  await journal.settled();
  assert.deepEqual(kept, [{ text: output, name: 'tool' }]);
  const saved = journal.items('run_1')[0];
  assert.equal(saved.data.outputBlob, BLOB);
  assert.equal(saved.data.output, item.data.output, 'the truncated text is not truncated again');
  assert.equal(of('run.item').length, 2, 'the update is announced');
});

test('ours through tools/journal.ts: the whole text reaches the blob, the preview is unchanged; short and registry-blob outputs are not kept again', async () => {
  const kept: string[] = [];
  const { journal } = setup(async (text) => { kept.push(text); return BLOB; });
  const services = { runs: journal, secrets: { redact: (text: string) => text }, log: { warn() {} } } as unknown as RuntimeServices;
  const long = 'x'.repeat(9_000);
  journalResult(services, 'run_1', 'files.read', 'c1', 'run_1:c1', { content: [{ type: 'text', text: long }] }, []);
  journalResult(services, 'run_1', 'chat.read', 'c2', 'run_1:c2', { content: [{ type: 'text', text: 'short' }] }, []);
  journalResult(services, 'run_1', 'web.fetch', 'c3', 'run_1:c3', { content: [{ type: 'text', text: 'y'.repeat(6_100) }] }, ['b'.repeat(64)]);
  await journal.settled();
  assert.deepEqual(kept, [long], 'only the long one without a registry blob');
  const [first, second, third] = journal.items('run_1');
  assert.equal(first.data.outputBlob, BLOB);
  assert.equal(first.data.outputChars, 9_000);
  assert.equal((first.data.preview as string).length, 601, 'preview: 600 characters and the ellipsis, as before');
  assert.equal(second.data.outputBlob, undefined);
  assert.equal(second.data.outputChars, undefined);
  assert.equal(third.data.outputBlob, undefined);
  assert.deepEqual(third.data.blobIds, ['b'.repeat(64)]);
});

test('a failed blob write is logged and never fails the item; without keepOutput nothing is kept', async () => {
  const failing = setup(async () => { throw new Error('disk full'); });
  const item = failing.journal.item('run_1', { kind: 'tool_result', data: { output: 'z'.repeat(5_000) }, effectStatus: 'none' });
  await failing.journal.settled();
  assert.equal(item.data.outputChars, 5_000);
  assert.equal(failing.journal.items('run_1')[0].data.outputBlob, undefined);
  assert.deepEqual(failing.warnings, ['tool output not kept whole']);
  const plain = new Journal({ db: memoryDb(), bus: recordingBus().bus, clock: clock() });
  plain.start({ id: 'run_1', agentId: 'ag_1', trigger: 'message' });
  const other = plain.item('run_1', { kind: 'note', data: { text: 'q'.repeat(5_000) }, effectStatus: 'none' });
  assert.equal(other.data.outputChars, undefined, 'only tool results');
  await plain.settled();
});
