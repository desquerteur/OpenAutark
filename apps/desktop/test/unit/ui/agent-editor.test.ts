// O6 agent editor rules (src/ui/team/editor-model.ts): the patch holds only changed fields (name, role,
// instructions, avatar), avatars per type and one-emoji input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Agent } from '../../../src/shared/model/org.ts';
import { avatarPaletteIndex } from '../../../src/shared/text/avatar-looks.ts';
import { draftAvatar, draftOf, editorPatch, firstEmoji, hasChanges, previewLook, shownColor } from '../../../src/ui/team/editor-model.ts';

function agent(id: string, patch: Partial<Agent> = {}): Agent {
  return {
    id, name: patch.name ?? id.toUpperCase(), role: 'Role', avatar: { kind: 'initials', value: 'A', color: avatarPaletteIndex(id) }, instructions: 'Be brief.',
    mode: 'general', skills: [], modelPolicy: {}, status: 'idle', createdBy: 'human', createdAt: 0, updatedAt: 0,
    ...patch,
  };
}

test('an untouched draft sends nothing; a rename alone keeps the generated avatar out of the patch', () => {
  const ada = agent('ag_ada', { name: 'Ada', avatar: { kind: 'initials', value: 'A', color: 2 }, managerId: 'ag_boss', team: 'Ops', voice: 'nova' });
  const draft = draftOf(ada);
  assert.deepEqual(editorPatch(ada, draft), {}, 'placement fields are not part of the editor');
  assert.equal(hasChanges(editorPatch(ada, draft)), false);
  const renamed = editorPatch(ada, { ...draft, name: '  Ada   Lovelace ', role: ' Analyst ' });
  assert.deepEqual(renamed, { name: 'Ada Lovelace', role: 'Analyst' }, 'the runtime renews generated initials itself');
  assert.deepEqual(editorPatch(ada, { ...draft, name: '   ' }), {}, 'an empty name is never sent');
});

test('avatars: a new color, emoji and image each send the whole avatar; initials follow the new name', () => {
  const ada = agent('ag_ada', { name: 'Ada', avatar: { kind: 'initials', value: 'A', color: 2 } });
  const draft = draftOf(ada);
  assert.deepEqual(editorPatch(ada, { ...draft, name: 'Grace Hopper', avatar: { kind: 'initials', value: 'A', color: 4 } }), {
    name: 'Grace Hopper', avatar: { kind: 'initials', value: 'GH', color: 4 },
  });
  assert.deepEqual(editorPatch(ada, { ...draft, avatar: { kind: 'emoji', value: ' 🎬 ', color: 2 } }).avatar, { kind: 'emoji', value: '🎬', color: 2 });
  assert.deepEqual(editorPatch(ada, { ...draft, avatar: { kind: 'image', value: 'f'.repeat(64), color: 2 } }).avatar, { kind: 'image', value: 'f'.repeat(64) }, 'images carry no color');
  const emoji = agent('ag_emo', { avatar: { kind: 'emoji', value: '🎬', color: 1 } });
  assert.deepEqual(editorPatch(emoji, draftOf(emoji)), {});
  assert.deepEqual(editorPatch(emoji, { ...draftOf(emoji), avatar: { kind: 'initials', value: '', color: 1 } }).avatar, { kind: 'initials', value: 'AE', color: 1 }, 'letters of "AG_EMO"');
  assert.deepEqual(draftAvatar({ name: '', avatar: { kind: 'initials', value: '' } }, 'Mira'), { kind: 'initials', value: 'M' });
});

test('preview: the look the avatar will be drawn with, and the swatch it marks', () => {
  const others = [agent('ag_1', { name: 'Mia', createdAt: 1 }), agent('ag_2', { name: 'Max', createdAt: 2 })];
  const look = previewLook(others, 'ag_2', 'Max', { kind: 'initials', value: 'M', color: (avatarPaletteIndex('ag_2') + 1) % 6 });
  assert.equal(look?.color, (avatarPaletteIndex('ag_2') + 1) % 6, 'a chosen color is kept');
  assert.equal(previewLook(others, 'ag_2', 'Max', { kind: 'emoji', value: '🎬', color: 3 }), undefined);
  assert.equal(shownColor('ag_2', { kind: 'emoji', value: '🎬', color: 3 }), 3);
  assert.equal(shownColor('ag_2', { kind: 'emoji', value: '🎬' }), avatarPaletteIndex('ag_2'));
});

test('emoji input: the first emoji (one grapheme), nothing for plain text', () => {
  assert.equal(firstEmoji('🎬 studio'), '🎬');
  assert.equal(firstEmoji(' 👩‍💻'), '👩‍💻');
  assert.equal(firstEmoji('🇩🇪'), '🇩🇪');
  assert.equal(firstEmoji('✍️'), '✍️');
  assert.equal(firstEmoji('abc'), '');
  assert.equal(firstEmoji(''), '');
});
