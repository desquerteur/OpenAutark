// q-r3 (after the checkers of q-r2d, 03.11.2026): what the main AI brings back and what it asks to take out. A restore made inside a
// code-mode script (Codex: `text(await tools.tools__call({name:"context.restore", …}))`) left the script's output – the whole original again –
// in full: a rebuilt history held the file twice (q-r2d s14), and the restore counted as a cost that held back later hides (s15/s16). A
// pinned item (the main AI's restore) was left out of the list of the run the main AI asked to take it out (s15), and the person was told it
// was gone. Real ledger, real journal; the brains' tools as the flow calls them.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ledgerSetup } from './ledger-fixture.ts';
import { contextTools } from '../../../src/runtime/subconscious/context-tools.ts';
import type { FlowRun, RunKind } from '../../../src/runtime/subconscious/tools.ts';
import { restoreItems } from '../../../src/runtime/context/ledger/restore.ts';
import { rebuildItems } from '../../../src/runtime/agents/rebuild-items.ts';

const FILE = `# Kundenakte Probe\n${'Zeile mit Inhalt der Akte.\n'.repeat(700)}`;
const RESTORE_SOURCE = 'text(await tools.tools__call({name:"context.restore",args:{ids:["t1"]}}));';

type Setup = ReturnType<typeof ledgerSetup>;

/** A script call as agents/turn-attempt.ts journals an engine-native call (tool_call own, then its tool_result). */
function script(h: Setup, runId: string, callId: string, source: string, output: string): void {
  h.journal.item(runId, { kind: 'tool_call', name: 'exec', data: { callId, own: true, args: JSON.stringify({ source }), summary: 'Ran a command' }, effectStatus: 'none' });
  h.journal.item(runId, { kind: 'tool_result', data: { callId, ok: true, summary: 'Script completed', output }, effectStatus: 'none' });
}

/** Turns 1–4: the file read first (t1), then three short turns; t1 condensed by the subconscious and that applied to the session. */
async function fileThenThree(h: Setup): Promise<void> {
  const first = h.turn(h.say('Lies bitte die Akte der Probe komplett.').seq);
  h.ourCall(first, 'files.read', { path: 'akten/probe.md' }, FILE, 'c1');
  h.done(first);
  for (let index = 2; index <= 4; index++) {
    const run = h.turn(h.say(`Und noch Schritt ${index}, bitte kurz.`).seq);
    h.ourCall(run, 'shell.exec', { command: `schritt ${index}` }, `Schritt ${index} fertig\n${'log\n'.repeat(300)}`, `c${index}`);
    h.done(run);
    h.clock.advance(1000);
  }
  await h.journal.settled();
  h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 'f1', state: 'condensed', condensed: 'Kundenakte Probe: Zeilen mit Inhalt.', reason: 'after-turn run', by: 'subconscious' }]);
  h.ledger.rebuilt(h.tom.id, h.chat.id, Math.max(...h.ledger.items(h.tom.id, h.chat.id).map((item) => item.order)));
}

/** The main AI's restore of f1 inside a script, as Codex code mode runs it: the nested call (an "exec-" id) and the script around it. */
async function restoreInScript(h: Setup, extra = ''): Promise<string> {
  const run = h.turn(h.say('Welche Zeile stand am Anfang der Akte?').seq);
  const output = restoreItems(h.services, h.tom.id, h.chat.id, { ids: ['f1'] });
  h.ourCall(run, 'context.restore', { ids: ['f1'] }, output, 'exec-restore-1');
  script(h, run, 'call_script_1', RESTORE_SOURCE.replace('t1', 'f1'), `Script completed\nWall time 0.1 seconds\nOutput:\n${output}${extra}`);
  h.done(run);
  await h.journal.settled();
  return run;
}

const byId = (h: Setup) => new Map(h.ledger.items(h.tom.id, h.chat.id).map((item) => [item.itemId, item]));
const scriptItem = (h: Setup) => h.ledger.items(h.tom.id, h.chat.id).find((item) => item.title.startsWith('exec: '))!;

test('a script that only restored is condensed like a direct restore: the rebuilt history holds the original once', async () => {
  const h = ledgerSetup();
  try {
    await fileThenThree(h);
    await restoreInScript(h);
    const item = scriptItem(h);
    assert.equal(item.state, 'condensed', 'its output was the whole file again');
    assert.match(item.condensed ?? '', /^Restored f1 – kept in my context for the next 3 turns\. They are back in place in my context\.$/);
    assert.equal(byId(h).get('f1')?.state, 'keep');
    const history = rebuildItems(h.ledger.view(h.tom.id, h.chat.id), 0).items;
    const holding = history.filter((entry) => (entry.call?.output ?? entry.text).includes('Zeile mit Inhalt der Akte.\nZeile mit Inhalt der Akte.'));
    assert.deepEqual(holding.map((entry) => entry.itemId), ['f1'], 'the file is in the history once, in its place');
  } finally { h.cleanup(); }
});

test('a script that printed much more than its restore keeps its output (the rest has no other place)', async () => {
  const h = ledgerSetup();
  try {
    await fileThenThree(h);
    await restoreInScript(h, `\n${'andere Ausgabe\n'.repeat(100)}`);
    assert.equal(scriptItem(h).state, 'keep');
  } finally { h.cleanup(); }
});

test('a restore alone rebuilds nothing; the next mark of the subconscious brings it along and counts in full (q-r2d s15)', async () => {
  const h = ledgerSetup();
  try {
    await fileThenThree(h);
    await restoreInScript(h);
    const alone = h.ledger.needsRebuild(h.tom.id, h.chat.id)!;
    assert.equal(alone.marked, false, 'a restore moves its item back; it takes nothing off');
    assert.ok(Math.abs(alone.saves) < 500, `the restore and its condensed result about balance: ${alone.saves}`);
    h.ledger.mark(h.tom.id, h.chat.id, [{ itemId: 't2', state: 'hidden', reason: 'before-turn run', by: 'subconscious', onWord: true }]);
    const withHide = h.ledger.needsRebuild(h.tom.id, h.chat.id)!;
    assert.equal(withHide.marked, true);
    assert.ok(withHide.saves > 0, `a small hide after a restore is worth a rebuild: ${withHide.saves}`);
  } finally { h.cleanup(); }
});

function runOf(h: Setup, kind: RunKind): FlowRun {
  return { services: h.services, agent: h.tom, conversationId: h.chat.id, thread: h.chat.id, kind, signal: new AbortController().signal, hits: new Map(), searches: [], show: () => {}, route: () => {}, finish: () => {} } as unknown as FlowRun;
}
const tool = (name: string) => contextTools.find((entry) => entry.name === name)!;

/** Two more turns after the restore, so f1 is older than the newest 2 turns and still pinned. */
async function twoMore(h: Setup): Promise<void> {
  for (let index = 6; index <= 7; index++) {
    const run = h.turn(h.say(`Schritt ${index}, bitte.`).seq);
    h.ourCall(run, 'shell.exec', { command: `schritt ${index}` }, 'ok', `c${index}`);
    h.done(run);
    h.clock.advance(1000);
  }
  await h.journal.settled();
}

test('a pinned item: the run after a turn leaves it, a run on the person\'s or the main AI\'s word sees it and takes it out', async () => {
  const h = ledgerSetup();
  try {
    await fileThenThree(h);
    await restoreInScript(h);
    await twoMore(h);
    assert.ok(byId(h).get('f1')?.pinnedUntil !== undefined, 'the restore pinned it');

    const tidy = String(await tool('context.list').run({}, runOf(h, 'after-turn')));
    assert.doesNotMatch(tidy, /\nf1 /, 'the subconscious\'s own tidying never meets it');
    assert.match(String(await tool('context.hide').run({ ids: ['f1'] }, runOf(h, 'after-turn'))), /left as they are: f1 \(pinned\)/);
    assert.equal(byId(h).get('f1')?.state, 'keep');

    for (const kind of ['asked', 'before-turn'] as const) assert.match(String(await tool('context.list').run({}, runOf(h, kind))), /\nf1 file \d+t \(the main AI brought it back\) File akten\/probe\.md/, kind);
    assert.match(String(await tool('context.hide').run({ ids: ['f1'] }, runOf(h, 'asked'))), /^hidden: f1/);
    assert.equal(byId(h).get('f1')?.state, 'hidden', 'the main AI asked: its own hold does not stop it');
    const history = rebuildItems(h.ledger.view(h.tom.id, h.chat.id), 0).items;
    assert.ok(!history.some((entry) => (entry.call?.output ?? entry.text).includes('Zeile mit Inhalt der Akte.')), 'nothing of the file is left in the history');
  } finally { h.cleanup(); }
});
