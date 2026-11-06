// Runtime default avatars: unchanged initials/hash color without context; with the org's other
// agents the stored color is the free one, so a new agent never repeats a same-letter color.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultAvatar, initials, PALETTE_SIZE, paletteIndex } from '../../../src/runtime/org/avatar.ts';
import { avatarPaletteIndex } from '../../../src/shared/text/avatar-looks.ts';

function idWithColor(color: number, skip: string[] = []): string {
  for (let i = 0; ; i++) {
    const id = `ag_${i}`;
    if (!skip.includes(id) && paletteIndex(id) === color) return id;
  }
}

test('initials and palette index keep their rules', () => {
  assert.equal(initials('Content Creator'), 'CC');
  assert.equal(initials('Manager'), 'M');
  assert.equal(initials('video_editor'), 'VE');
  assert.equal(initials('  '), '?');
  assert.equal(paletteIndex('ag_123'), avatarPaletteIndex('ag_123'));
  for (const id of ['a', 'ag_x', 'ag_long_identifier']) assert.ok(paletteIndex(id) >= 0 && paletteIndex(id) < PALETTE_SIZE);
});

test('without other agents the default is the plain hash color', () => {
  assert.deepEqual(defaultAvatar('ag_7', 'Mira'), { kind: 'initials', value: 'M', color: paletteIndex('ag_7') });
  assert.deepEqual(defaultAvatar('ag_7', 'Mira', []), { kind: 'initials', value: 'M', color: paletteIndex('ag_7') });
});

test('with the org passed, a same-letter newcomer gets a free color and keeps plain initials', () => {
  const first = idWithColor(2);
  const second = idWithColor(2, [first]);
  const existing = [{ id: first, name: 'Mira', createdAt: 10, avatar: defaultAvatar(first, 'Mira') }];
  const avatar = defaultAvatar(second, 'Max', existing);
  assert.equal(avatar.kind, 'initials');
  assert.equal(avatar.value, 'M');
  assert.notEqual(avatar.color, existing[0].avatar.color);
});

test('a rename passes the agent itself among the others without colliding with itself', () => {
  const id = idWithColor(4);
  const self = { id, name: 'Mira', createdAt: 1, avatar: defaultAvatar(id, 'Mira') };
  assert.equal(defaultAvatar(id, 'Mara', [self]).color, paletteIndex(id));
});
