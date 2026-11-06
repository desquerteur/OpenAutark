// distinctLooks: agents of one org get different looks – free colors by creation order, a
// second letter when initials still collide; chosen colors, images and emoji are kept.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarInitials, avatarPaletteIndex, distinctLooks, PALETTE_SIZE } from '../../../src/shared/text/avatar-looks.ts';
import type { LookInput } from '../../../src/shared/text/avatar-looks.ts';

function agent(id: string, name: string, createdAt: number, avatar?: LookInput['avatar']): LookInput {
  return { id, name, createdAt, avatar: avatar ?? { kind: 'initials', value: avatarInitials(name), color: avatarPaletteIndex(id) } };
}

/** Ids whose hash colors are all the same (the collision the review found). */
function collidingIds(count: number): string[] {
  const target = avatarPaletteIndex('ag_seed');
  const ids: string[] = [];
  for (let i = 0; ids.length < count; i++) if (avatarPaletteIndex(`ag_${i}`) === target) ids.push(`ag_${i}`);
  return ids;
}

test('agents with the same initial get different colors even when their hash colors collide', () => {
  const [a, b, c] = collidingIds(3);
  const looks = distinctLooks([agent(a, 'Mira', 1), agent(b, 'Max', 2), agent(c, 'Mona', 3)]);
  const colors = [a, b, c].map((id) => looks.get(id)!.color);
  assert.equal(new Set(colors).size, 3);
  assert.equal(colors[0], avatarPaletteIndex(a), 'the first agent keeps its own color');
});

test('a single colliding initial gets a second letter; the earlier agent keeps its letter', () => {
  const [a, b, c] = collidingIds(3);
  const looks = distinctLooks([agent(a, 'Mira', 1), agent(b, 'Max', 2), agent(c, 'Mona', 3)]);
  assert.equal(looks.get(a)!.text, 'M');
  assert.equal(looks.get(b)!.text, 'Ma');
  assert.equal(looks.get(c)!.text, 'Mo');
});

test('two-letter initials that collide keep their letters but not their color', () => {
  const [a, b] = collidingIds(2);
  const looks = distinctLooks([agent(a, 'Video Editor', 1), agent(b, 'Visual Effects', 2)]);
  assert.equal(looks.get(a)!.text, 'VE');
  assert.equal(looks.get(b)!.text, 'VE');
  assert.notEqual(looks.get(a)!.color, looks.get(b)!.color);
});

test('when the palette runs out for one letter, the text tells them apart', () => {
  const names = ['Ann', 'Abe', 'Ada', 'Amy', 'Ava', 'Ari', 'Alf'];
  const looks = distinctLooks(names.map((name, i) => agent(`ag_${name}`, name, i)));
  const shown = names.map((name) => looks.get(`ag_${name}`)!);
  assert.equal(new Set(shown.slice(0, PALETTE_SIZE).map((look) => look.color)).size, PALETTE_SIZE);
  assert.equal(new Set(shown.map((look) => `${look.text}|${look.color}`)).size, names.length);
  assert.equal(new Set(shown.map((look) => look.text.toLowerCase())).size, names.length);
});

test('agents with different letters spread over free colors', () => {
  const ids = collidingIds(6);
  const names = ['Manager', 'Researcher', 'Writer', 'Designer', 'Operations', 'Secretary'];
  const looks = distinctLooks(ids.map((id, i) => agent(id, names[i], i)));
  assert.equal(new Set(ids.map((id) => looks.get(id)!.color)).size, 6);
});

test('stable: earlier agents keep their look when later ones are hired; input order does not matter', () => {
  const [a, b, c] = collidingIds(3);
  const first = distinctLooks([agent(a, 'Mira', 1), agent(b, 'Max', 2)]);
  const later = distinctLooks([agent(c, 'Mona', 3), agent(b, 'Max', 2), agent(a, 'Mira', 1)]);
  assert.deepEqual(later.get(a), first.get(a));
  assert.deepEqual(later.get(b), first.get(b));
});

test('a color chosen on purpose is kept; image and emoji avatars are left alone', () => {
  const [a, b] = collidingIds(2);
  const chosen = (avatarPaletteIndex(b) + 1) % PALETTE_SIZE;
  const looks = distinctLooks([
    agent(a, 'Mira', 1),
    agent(b, 'Max', 2, { kind: 'initials', value: 'M', color: chosen }),
    agent('ag_img', 'Photo', 3, { kind: 'image', value: 'f'.repeat(64) }),
    agent('ag_emoji', 'Bee', 4, { kind: 'emoji', value: '🐝', color: 2 }),
  ]);
  assert.equal(looks.get(b)!.color, chosen);
  assert.equal(looks.has('ag_img'), false);
  assert.equal(looks.has('ag_emoji'), false);
});

test('agents without an avatar or with custom initials text are handled', () => {
  const looks = distinctLooks([
    { id: 'ag_1', name: 'Nora' },
    { id: 'ag_2', name: 'Nico', avatar: { kind: 'initials', value: 'NX' } },
    { id: 'ag_3', name: '   ' },
  ]);
  assert.equal(looks.get('ag_1')!.text, 'N');
  assert.equal(looks.get('ag_2')!.text, 'NX');
  assert.equal(looks.get('ag_3')!.text, '?');
  for (const look of looks.values()) assert.ok(look.color >= 0 && look.color < PALETTE_SIZE);
});
