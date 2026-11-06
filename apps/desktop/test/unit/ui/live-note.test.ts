// The chat header's live line never shows a raw tool name (visual pass, round 3, C5): a bare tool name
// an engine reports as its live note reads as what the agent does (lib/format.ts workNote); any other
// note stays as written; and its three lengths (chat/live-text.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workNote } from '../../../src/ui/lib/format.ts';

test('workNote: bare tool names read as what the agent does', () => {
  assert.equal(workNote('bash'), 'running a command');
  assert.equal(workNote('  Bash '), 'running a command');
  assert.equal(workNote('shell.exec'), 'running a command');
  assert.equal(workNote('Browser show'), 'showing a page');
  assert.equal(workNote('browser.show'), 'showing a page');
  assert.equal(workNote('browser.navigate'), 'opening a page');
  assert.equal(workNote('browser.click'), 'using the browser');
  assert.equal(workNote('web_search'), 'searching the web');
  assert.equal(workNote('apply_patch'), 'editing files');
  assert.equal(workNote('read_file'), 'reading a file');
});

test('workNote: a note that already says what happens stays as written', () => {
  assert.equal(workNote('cutting intro'), 'cutting intro');
  assert.equal(workNote('Running npm test'), 'Running npm test');
  assert.equal(workNote('Searching the web “launch dates”'), 'Searching the web “launch dates”');
});

// fix round 2 (C-chat-header-list): the live line in three lengths for the sub line's widths (chat.css) –
// a narrow window keeps one agent's step, a phone names who works; a 1:1 keeps its step everywhere
test('live line: full, narrow and phone forms', async () => {
  const { liveNames, liveShort, liveStatus } = await import('../../../src/ui/chat/live-text.ts');
  const names: Record<string, string> = { m: 'Manager', a: 'Ava', i: 'Mira', j: 'Jonas' };
  const nameOf = (id: string) => names[id];
  const chat = { id: 'c1', working: [] as string[] };
  const one = [{ agentId: 'm', conversationId: 'c1', note: 'bash' }, { agentId: 'a', conversationId: 'other', note: 'bash' }];
  const three = [{ agentId: 'a', conversationId: 'c1', note: 'bash' }, { agentId: 'i', conversationId: 'c1', note: 'cutting intro' }, { agentId: 'j', conversationId: 'c1', note: '' }];
  assert.equal(liveStatus(chat, undefined, one, nameOf), 'Manager: running a command');
  assert.equal(liveShort(chat, undefined, one, nameOf), 'Manager: running a command');
  assert.equal(liveNames(chat, undefined, one, nameOf), 'Manager is working');
  assert.equal(liveStatus(chat, undefined, three, nameOf), 'Ava: running a command, Mira: cutting intro +1');
  assert.equal(liveShort(chat, undefined, three, nameOf), 'Ava, Mira +1');
  assert.equal(liveNames(chat, undefined, three, nameOf), 'Ava, Mira +1');
  const solo = [{ agentId: 'a', conversationId: 'c1', note: 'bash' }];
  for (const form of [liveStatus, liveShort, liveNames]) assert.equal(form(chat, 'a', solo, nameOf), 'Running a command');
  assert.equal(liveNames({ id: 'c1', working: ['a', 'i'] }, undefined, [], nameOf), 'Ava, Mira', 'without activity: the summary\'s names');
});
