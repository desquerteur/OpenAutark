// AF-015 – the call card in the chat (ui/chat/call/call-card.ts, drawn by CallTranscript.tsx): who the call was with
// (the agents heard in it, else the chat's name), how long it ran or that it runs, how many lines its transcript has;
// and the card's markup keeps the transcript behind its disclosure (open while the call runs, closed once it ended).
// Owns: these assertions only. Never: a runtime or a rendered DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallLine } from '../../../src/shared/model/call.ts';
import { callCardView, callPartners } from '../../../src/ui/chat/call/call-card.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const line = (from: string, name: string, text = 'Hi'): CallLine => ({ at: 1000, from, name, text });

test('call card: an ended call shows who it was with, its length and its lines', () => {
  const view = callCardView({ startedAt: 0, endedAt: 282_000, lines: [line('device:pc', 'This PC'), line('agent:ag_ava', 'Ava'), line('device:pc', 'This PC')] }, 'Launch plan');
  assert.deepEqual(view, { title: 'Call with Ava', length: '4:42', running: false, lines: '3 lines', count: 3 });
});

test('call card: a running call says so; nothing said yet names the chat; one line is "1 line"', () => {
  assert.deepEqual(callCardView({ startedAt: 0, lines: [] }, 'Launch plan'), { title: 'Call with Launch plan', length: 'Running', running: true, lines: 'Nothing said', count: 0 });
  assert.equal(callCardView({ startedAt: 0, endedAt: 5000, lines: [line('device:pc', 'This PC')] }).lines, '1 line');
  assert.equal(callCardView({ startedAt: 0, endedAt: 5000, lines: [] }).title, 'Call', 'no agent, no chat name');
  assert.equal(callCardView({ startedAt: 0, endedAt: 3_725_000, lines: [] }).length, '1:02:05');
});

test('call partners: agents in the order they first spoke, each once; three and more are shortened', () => {
  assert.equal(callPartners({ lines: [line('agent:a', 'Ava'), line('agent:m', 'Mira'), line('agent:a', 'Ava')] }), 'Ava and Mira');
  assert.equal(callPartners({ lines: [line('agent:a', 'Ava'), line('agent:m', 'Mira'), line('agent:k', 'Kai'), line('agent:z', 'Zoe')] }), 'Ava, Mira +2');
  assert.equal(callPartners({ lines: [line('device:pc', 'This PC')] }), '', 'the person is not a partner');
});

test('call card markup: the transcript sits behind its disclosure, open exactly while the call runs unless toggled', () => {
  const source = readFileSync(path.join(root, 'src/ui/chat/call/CallTranscript.tsx'), 'utf8');
  assert.match(source, /const open = choice \?\? card\.running;/);
  assert.match(source, /class="call-transcript-toggle" aria-expanded=\{open\} aria-controls=\{bodyId\}/);
  assert.match(source, /\{open && <div class="call-transcript-body" id=\{bodyId\}>/);
  assert.match(source, /callCardView\(call, chat \? chatTitle\(chat\) : undefined\)/);
});

test('the call button carries the tour name and the call view is a layer of its own, not a panel', () => {
  const header = readFileSync(path.join(root, 'src/ui/chat/call/CallHeader.tsx'), 'utf8');
  assert.equal((header.match(/tour: 'call-button'/g) ?? []).length, 2, 'Talk and End voice');
  assert.match(readFileSync(path.join(root, 'src/ui/lib/header.tsx'), 'utf8'), /data-tour=\{cell\.tour\}/);
  const shell = readFileSync(path.join(root, 'src/ui/shell/Shell.tsx'), 'utf8');
  assert.match(shell, /<CallOverlay \/>/, 'mounted with the global overlays');
});
