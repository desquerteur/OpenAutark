// B-076 (owner 05.11.2026: "den kompletten letzten Runtime-Ding … was er eben alles durchgeführt hat"): last-run.md
// holds the turn's input, every step of its run log and its final text; secrets are redacted, long parts cut.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { LAST_RUN_FILE, lastRunText, writeLastRun } from '../../../src/runtime/context/last-run.ts';
import type { RunItem } from '../../../src/shared/model/runs.ts';
import { tempDir } from '../store/helpers.ts';

const item = (seq: number, kind: RunItem['kind'], data: Record<string, unknown>, name?: string): RunItem => ({ id: `i${seq}`, runId: 'run_1', seq, kind, data, createdAt: seq, ...(name ? { name } : {}) });

test('last-run.md: the input, every step in order (calls with arguments, results, thinking, errors) and the final text', () => {
  const text = lastRunText({
    runId: 'run_1', trigger: 'message', model: 'claude:claude-opus-5-5', effort: 'high', status: 'done', endedAt: Date.UTC(2026, 10, 5, 13, 51),
    input: '[14:50] Alex: öffne mal die Datei',
    items: [
      item(3, 'tool_result', { ok: true, preview: 'Tab opened' }),
      item(1, 'reasoning', { summary: 'I open last-prompt.md in the global pane.' }),
      item(2, 'tool_call', { args: '{"path":"last-prompt.md"}', summary: 'Open a file tab' }, 'browser.show'),
      item(4, 'error', { message: 'x'.repeat(5000) }),
    ],
    finalText: 'Die Datei ist offen.',
  });
  assert.match(text, /^<!-- What I did on my last turn/);
  assert.match(text, /# Last turn – run_1\nmessage · claude:claude-opus-5-5 · effort high · done · 2026-11-05T13:51:00\.000Z/);
  assert.match(text, /## What came in\n\[14:50\] Alex: öffne mal die Datei/);
  assert.ok(text.indexOf('_Thinking:_') < text.indexOf('**Call browser.show**') && text.indexOf('**Call browser.show**') < text.indexOf('→ result: Tab opened'), 'in run order');
  assert.match(text, /\{"path":"last-prompt\.md"\}/);
  assert.match(text, /\*\*Error:\*\* x+\n… \(cut: 3000 more characters\)/);
  assert.match(text, /## My final text\nDie Datei ist offen\./);
});

test('final review fixes: engine results show their output, results sit under their call, the answer note is not a step', () => {
  const text = lastRunText({
    runId: 'run_4', endedAt: 0, input: '',
    items: [
      item(1, 'tool_call', { callId: 'a', args: '{"command":"npm test"}' }, 'Bash'),
      item(2, 'tool_call', { callId: 'b', args: '{"file":"x.ts"}' }, 'Read'),
      item(3, 'tool_result', { callId: 'a', ok: true, summary: 'exit 0', output: 'all 12 tests passed' }, 'Bash'),
      item(4, 'tool_result', { callId: 'b', ok: true, output: { content: [{ type: 'text', text: 'file text' }] } }, 'Read'),
      item(5, 'note', { answer: true, text: 'Done.' }, 'Answer'),
    ],
    finalText: 'Done.',
  });
  assert.match(text, /→ result: exit 0\n {4}all 12 tests passed/, 'the engine tool\'s output, not only its status word');
  const at = (s: string) => text.indexOf(s);
  assert.ok(at('**Call Bash**') < at('all 12 tests passed') && at('all 12 tests passed') < at('**Call Read**') && at('**Call Read**') < at('file text'), 'each result under its call');
  assert.match(text, /## What I did \(4 steps\)/);
  assert.equal(text.split('Done.').length - 1, 1, 'the final text once');
});

test('a long input keeps its end (the new messages); a long run keeps its newest steps and the final text; a secret on a cut point is still redacted', () => {
  const input = `${'old line\n'.repeat(4000)}New messages:\n[15:02] Alex: mach weiter`;
  const items = Array.from({ length: 200 }, (_, i) => item(i + 1, 'reasoning', { summary: `step ${i + 1} ${'y'.repeat(1990)}` }));
  const secret = 'sk-live-ABCDEFGHIJ';
  items.push(item(201, 'error', { message: `${'z'.repeat(1990)}${secret}` }));
  const text = lastRunText({ runId: 'run_5', endedAt: 0, input, items, finalText: 'Fertig.' }, (s) => s.split(secret).join('secret://sec_k'));
  assert.match(text, /\[15:02\] Alex: mach weiter/, 'the turn\'s new message survives the input cut');
  assert.match(text, /## My final text\nFertig\./, 'the final text always stays');
  assert.match(text, /… \(\d+ earlier steps left out – Team › Runs has them\)/);
  assert.ok(text.includes('step 200 '), 'the newest steps stay');
  assert.ok(!text.includes('step 1 '), 'the oldest go');
  assert.ok(!text.includes('sk-live-ABC'), 'redacted before the 2,000-character cut');
  assert.ok(text.length <= 200_000);
});

test('written beside last-prompt.md with secrets redacted; no agent folder, no file', (t) => {
  const dir = tempDir('autark-last-run-');
  t.after(() => dir.cleanup());
  const folder = path.join(dir.dir, 'agents', 'ag_konrad');
  mkdirSync(folder, { recursive: true });
  writeLastRun(dir.dir, 'ag_konrad', { runId: 'run_2', endedAt: 0, input: 'key sk-live-1234', items: [] }, (text) => text.replace('sk-live-1234', 'secret://sec_key'));
  const written = readFileSync(path.join(folder, LAST_RUN_FILE), 'utf8');
  assert.match(written, /key secret:\/\/sec_key/);
  assert.ok(!written.includes('sk-live-1234'));
  assert.match(written, /\(no tool calls\)/);
  writeLastRun(dir.dir, 'not-an-agent', { runId: 'run_3', endedAt: 0, input: '', items: [] }); // never throws
});
