// B-055 G (WORK-PRESENCE): the "## Working nearby" section (work-presence/context-line.ts, prompt-volatile.ts 'work-nearby'):
//  - nothing when nobody works nearby; only files this agent read/changed or below its folder (not another task's
//    worktree), other agents only, one line per agent (newest two files, "+N more");
//  - "still working" while the change's turn runs, "N min ago" after; gone after 10 min unless the turn still runs;
//  - the overlap note first and once, never also as a nearby line in the same turn;
//  - at most 3 lines and 300 characters; sent again only when it changed (agents/volatile-delta.ts).
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { agoText, HEADER, MAX_CHARS, MAX_LINES, workNearbySection } from '../../../src/runtime/work-presence/context-line.ts';
import { volatileDelta } from '../../../src/runtime/agents/volatile-delta.ts';
import { volatileSections } from '../../../src/runtime/context/prompt-volatile.ts';
import { MIN, presenceSetup } from './fixture.ts';

function world() {
  const s = presenceSetup();
  const home = path.join(s.workspace, 'ada-home');
  s.homes.set('ag_ada', home);
  let calls = 0;
  const call = (runId: string, name: string, file: string) => {
    s.clock.advance(1000);
    s.journalEvent(runId, { type: 'tool_start', callId: `call_${++calls}`, name, own: true, args: { file_path: file } });
  };
  const section = (agentId = 'ag_ada') => workNearbySection(s.services, { agent: { id: agentId } });
  return { ...s, home, call, section };
}

test('agoText: just now, minutes, hours', () => {
  assert.equal(agoText(0, 59_000), 'just now');
  assert.equal(agoText(0, 4 * MIN + 5), '4 min ago');
  assert.equal(agoText(0, 125 * MIN), '2 h ago');
  assert.equal(agoText(10, 0), 'just now', 'a clock skew is no negative age');
});

test('relevance: files the agent read or changed, or below its folder – not elsewhere, not in another task\'s worktree, never its own', () => {
  const w = world();
  try {
    assert.equal(w.section(), '', 'nothing when nobody works nearby');
    const ada = w.turn('ag_ada');
    w.call(ada, 'Read', path.join(w.workspace, 'shared', 'readme.md'));
    w.call(ada, 'Edit', path.join(w.home, 'own.ts'));
    assert.equal(w.section(), '', 'her own work is no news');
    const bob = w.turn('ag_bob');
    w.call(bob, 'Edit', path.join(w.workspace, 'elsewhere', 'x.ts'));
    w.call(bob, 'Edit', path.join(w.home, '.worktrees', 'repo-1', 'task', 'app.ts'));
    assert.equal(w.section(), '', 'neither touched by Ada nor in her folder');
    w.call(bob, 'Edit', path.join(w.workspace, 'shared', 'readme.md'));
    w.call(bob, 'Write', path.join(w.home, 'src', 'app.ts'));
    assert.equal(w.section(), `${HEADER}\nBob is editing src/app.ts, shared/readme.md (just now, still working).`);
    w.call(bob, 'Edit', path.join(w.home, 'src', 'b.ts'));
    w.call(bob, 'Edit', path.join(w.home, 'src', 'c.ts'));
    assert.equal(w.section(), `${HEADER}\nBob is editing src/c.ts, src/b.ts +2 more (just now, still working).`);
  } finally { w.cleanup(); }
});

test('time: "still working" while the turn runs, then "N min ago"; after 10 min gone – unless the turn still runs', () => {
  const w = world();
  try {
    const bob = w.turn('ag_bob');
    w.call(bob, 'Edit', path.join(w.home, 'src', 'app.ts'));
    w.clock.advance(12 * MIN);
    assert.equal(w.section(), `${HEADER}\nBob is editing src/app.ts (12 min ago, still working).`, 'a running turn keeps it');
    w.end(bob);
    assert.equal(w.section(), '', 'ended and older than 10 min');
    const again = w.turn('ag_bob');
    w.call(again, 'Edit', path.join(w.home, 'src', 'app.ts'));
    w.end(again);
    w.clock.advance(4 * MIN);
    assert.equal(w.section(), `${HEADER}\nBob edited src/app.ts (4 min ago).`);
  } finally { w.cleanup(); }
});

test('overlap: the note comes first and once, and the same change is not said twice in that turn', () => {
  const w = world();
  try {
    const file = path.join(w.workspace, 'src', 'app.ts');
    const ada = w.turn('ag_ada');
    w.call(ada, 'Edit', file);
    w.clock.advance(MIN);
    const bob = w.turn('ag_bob');
    w.call(bob, 'Edit', file);
    w.end(bob);
    w.end(ada);
    const first = w.section();
    assert.equal(first, `${HEADER}\nBob also changed src/app.ts while I worked on it – I check before I continue.`);
    assert.equal(w.section(), `${HEADER}\nBob edited src/app.ts (just now).`, 'said once; the change itself stays news for 10 min');
    assert.equal(w.section('ag_bob'), `${HEADER}\nAda edited src/app.ts (1 min ago).`, 'Bob gets no note – Ada changed it before his turn');
  } finally { w.cleanup(); }
});

test('caps: at most 3 lines and 300 characters with the header; a line that does not fit leaves room for a shorter one', () => {
  const w = world();
  const w2 = world();
  try {
    for (let i = 0; i < 6; i++) {
      const id = `ag_x${i}`;
      w.agents.set(id, { id, name: `Colleague number ${i}` });
      w.call(w.turn(id), 'Edit', path.join(w.home, `x${i}.ts`));
    }
    const short = w.section().split('\n');
    assert.equal(short.length, 1 + MAX_LINES, short.join('\n'));
    assert.match(short[1], /^Colleague number 5 is editing x5\.ts /, 'newest first');
    for (let i = 0; i < 4; i++) {
      const id = `ag_y${i}`;
      w2.agents.set(id, { id, name: `Colleague number ${i}` });
      const run = w2.turn(id);
      const folder = path.join(w2.home, 'a-rather-long-folder-name', `deeper-folder-${i}`);
      if (i === 1) w2.call(run, 'Edit', path.join(folder, 'c1.tsx'));
      else for (const name of [`component-${i}.tsx`, `style-${i}.css`]) w2.call(run, 'Edit', path.join(folder, name));
    }
    const text = w2.section();
    assert.ok(text.length <= MAX_CHARS, `${text.length} chars: ${text}`);
    assert.deepEqual(text.split('\n').map((line) => line.split(' is editing')[0]), [HEADER, 'Colleague number 3', 'Colleague number 1'], 'number 2 does not fit any more; number 1 (one file) still does');
  } finally { w.cleanup(); w2.cleanup(); }
});

test('delta: the section goes again only when it changed; when it ends the session hears "No longer current"', () => {
  const w = world();
  try {
    const bob = w.turn('ag_bob');
    w.call(bob, 'Edit', path.join(w.home, 'src', 'app.ts'));
    const asSections = (text: string) => (text ? [{ name: 'work-nearby', text }] : []);
    const one = volatileDelta(asSections(w.section()), undefined);
    assert.match(one.text, /Bob is editing src\/app\.ts \(just now, still working\)/);
    const two = volatileDelta(asSections(w.section()), one.sections);
    assert.equal(two.text, 'Unchanged since my last turn: Working nearby.');
    w.clock.advance(2 * MIN);
    const three = volatileDelta(asSections(w.section()), two.sections);
    assert.match(three.text, /\(2 min ago, still working\)/);
    w.end(bob);
    w.clock.advance(11 * MIN);
    assert.equal(volatileDelta(asSections(w.section()), three.sections).text, 'No longer current: Working nearby.');
  } finally { w.cleanup(); }
});

test('prompt-volatile: the section is part of the volatile prompt as "work-nearby" (absent when empty)', () => {
  const w = world();
  try {
    const input = { agent: { id: 'ag_ada', name: 'Ada' } as never, route: { modelId: 'test:model', effort: 'medium' } as never };
    assert.equal(volatileSections(w.services, input).some((section) => section.name === 'work-nearby'), false);
    const bob = w.turn('ag_bob');
    w.call(bob, 'Edit', path.join(w.home, 'src', 'app.ts'));
    const section = volatileSections(w.services, input).find((item) => item.name === 'work-nearby');
    assert.equal(section?.text, `${HEADER}\nBob is editing src/app.ts (just now, still working).`);
  } finally { w.cleanup(); }
});
