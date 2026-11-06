// The pane's app tabs without a window: Notes (src/ui/workspace/notes-sync.ts – load, save after a
// pause, last write wins over a newer version, someone else's change loaded only while nothing typed
// waits), Video (video-versions.ts – renders grouped by name, the newest shown unless one is picked)
// and Media (media-facts.ts – how a file is shown and its one-line facts).
// Owns: these assertions only. Never: RPC, the DOM or Electron.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatNotes } from '../../../src/shared/model/notes.ts';
import type { MediaInfo } from '../../../src/shared/model/media.ts';
import { NotesSync } from '../../../src/ui/workspace/notes-sync.ts';
import { pickAfter, renderKey, shownVideo, videoRenders } from '../../../src/ui/workspace/video-versions.ts';
import { durationLabel, mediaFacts, viewKind } from '../../../src/ui/workspace/media-facts.ts';

class Conflict extends Error {}

/** A runtime's notes: a save on an older version is refused like notes.save does. */
function runtime(start: ChatNotes = { conversationId: 'c', text: 'start', version: 1, updatedBy: 'agent-a', updatedAt: 1 }) {
  let notes = { ...start };
  const saves: Array<[string, number]> = [];
  return {
    saves,
    now: () => notes,
    agentWrites: (text: string) => { notes = { ...notes, text, version: notes.version + 1, updatedBy: 'agent-b' }; },
    calls: {
      get: async () => ({ ...notes }),
      save: async (text: string, baseVersion: number) => {
        saves.push([text, baseVersion]);
        if (baseVersion !== notes.version) throw new Conflict('conflict');
        notes = { ...notes, text, version: notes.version + 1, updatedBy: 'human' };
        return { ...notes };
      },
      conflict: (error: unknown) => error instanceof Conflict,
      errorText: (error: unknown) => (error as Error).message,
    },
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

test('notes: loaded, saved after the pause on the version they were made on', async () => {
  const rt = runtime();
  const sync = new NotesSync(rt.calls, 1);
  await sync.load();
  assert.deepEqual([sync.state.value.text, sync.state.value.version, sync.state.value.updatedBy], ['start', 1, 'agent-a']);
  sync.edit('mine');
  assert.equal(sync.state.value.dirty, true);
  await tick();
  await sync.flush();
  assert.deepEqual(rt.saves, [['mine', 1]]);
  assert.deepEqual([sync.state.value.dirty, sync.state.value.version, sync.state.value.updatedBy], [false, 2, 'human']);
});

test('notes: the last write wins over a version someone saved meanwhile', async () => {
  const rt = runtime();
  const sync = new NotesSync(rt.calls, 60_000);
  await sync.load();
  sync.edit('mine');
  rt.agentWrites('theirs');
  sync.changed(2); // the event while the person's text waits: nothing is loaded over it
  await tick();
  assert.equal(sync.state.value.text, 'mine');
  await sync.flush();
  assert.deepEqual(rt.saves, [['mine', 1], ['mine', 2]], 'refused on the old version, saved again on the newer one');
  assert.equal(rt.now().text, 'mine');
  assert.equal(sync.state.value.dirty, false);
});

test('notes: someone else\'s change is loaded while nothing typed waits; a failing save says why', async () => {
  const rt = runtime();
  const sync = new NotesSync(rt.calls, 60_000);
  await sync.load();
  rt.agentWrites('agent text');
  sync.changed(1);
  await tick();
  assert.equal(sync.state.value.text, 'start', 'an older or the same version loads nothing');
  sync.changed(2);
  await tick();
  assert.deepEqual([sync.state.value.text, sync.state.value.updatedBy], ['agent text', 'agent-b']);

  const broken = new NotesSync({ ...rt.calls, save: async () => { throw new Error('Notes are too long.'); } }, 60_000);
  await broken.load();
  broken.edit('x'.repeat(10));
  await broken.flush();
  assert.equal(broken.state.value.error, 'Notes are too long.');
  assert.equal(broken.state.value.dirty, true, 'the text stays for the next try');
});

const row = (fileId: string, name: string, createdAt: number, patch: Partial<MediaInfo> = {}): MediaInfo => ({ fileId, name, kind: 'video', mime: 'video/mp4', createdAt, updatedAt: createdAt, ...patch });

test('video: renders grouped by name stem, oldest version first; the newest render shows unless one is picked', () => {
  assert.equal(renderKey('Intro_v2.mp4'), 'intro');
  assert.equal(renderKey('renders/intro-final.mp4'), 'intro');
  assert.equal(renderKey('intro (3).mov'), 'intro');
  assert.equal(renderKey('outro.mp4'), 'outro');
  const renders = videoRenders([
    row('a1', 'intro_v1.mp4', 1), row('b1', 'outro.mp4', 2), row('a2', 'intro_v2.mp4', 3), row('img', 'cover.png', 4, { kind: 'image', mime: 'image/png' }),
  ]);
  assert.deepEqual(renders.map((render) => [render.key, render.versions.map((version) => version.fileId)]), [['intro', ['a1', 'a2']], ['outro', ['b1']]]);
  assert.deepEqual(shownVideo(renders, null)?.render.key, 'intro');
  assert.equal(shownVideo(renders, null)?.index, 1, 'the newest version');
  assert.deepEqual([shownVideo(renders, 'a1')?.render.key, shownVideo(renders, 'a1')?.index], ['intro', 0]);
  assert.deepEqual([shownVideo(renders, 'gone')?.render.key, shownVideo(renders, 'b1')?.render.key], ['intro', 'outro']);
  assert.equal(pickAfter(renders, 'a2'), null, 'picking the newest follows the newest again');
  assert.equal(pickAfter(renders, 'a1'), 'a1');
  assert.equal(shownVideo([], null), undefined);
});

test('media: how a file is shown and its facts', () => {
  assert.equal(viewKind('image/png', 'x'), 'image');
  assert.equal(viewKind('application/octet-stream', 'clip.MOV'), 'video');
  assert.equal(viewKind('audio/mpeg', 'voice'), 'audio');
  assert.equal(viewKind('application/pdf', 'doc'), 'pdf');
  assert.equal(viewKind('text/plain', 'notes.txt'), 'file');
  assert.equal(durationLabel(42_000), '0:42');
  assert.equal(durationLabel(3_729_000), '1:02:09');
  assert.equal(mediaFacts({ width: 1280, height: 720, durationMs: 42_000, size: 3.2 * 1024 * 1024 }), '1280×720 · 0:42 · 3.2 MB');
  assert.equal(mediaFacts({ pages: 12, size: 840 * 1024 }), '12 pages · 840 KB');
  assert.equal(mediaFacts({}), '');
});
