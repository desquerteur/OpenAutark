// "Link my Telegram" helpers of the chat details Telegram row (src/ui/chat/details/bridge-owner-model.ts,
// C9): when a link is offered, the texts, and when a shown code stops being usable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_LINK_CODE_MS } from '../../../src/shared/model/bridges.ts';
import type { Bridge, OwnerLinkCode } from '../../../src/shared/model/bridges.ts';
import { canLinkOwner, codeExpired, codeHint, codeUsed, linkCommandText, ownerText } from '../../../src/ui/chat/details/bridge-owner-model.ts';

const BRIDGE: Bridge = { id: 'br_1', kind: 'telegram', conversationId: 'ch_1', externalChatId: '-100777', status: 'connected', createdAt: 1, updatedAt: 1 };
const CODE: OwnerLinkCode = { bridgeId: 'br_1', code: 'ABCD2345', expiresAt: 1_000_000 + OWNER_LINK_CODE_MS };

test('a link is offered for groups and private chats, never for channels or stopped bridges', () => {
  assert.ok(canLinkOwner(BRIDGE));
  assert.ok(canLinkOwner({ ...BRIDGE, status: 'error', error: 'Telegram is not reachable.' }));
  assert.ok(!canLinkOwner({ ...BRIDGE, externalChatId: '@team_news' }));
  assert.ok(!canLinkOwner({ ...BRIDGE, status: 'stopped' }));
});

test('texts: the command to send, the hint with the deadline, the linked account', () => {
  assert.equal(linkCommandText(CODE), '/link ABCD2345');
  assert.equal(codeHint(CODE, '14:32'), 'Send /link ABCD2345 in this Telegram chat from your own account by 14:32, as yourself (not as an anonymous admin). If you mistype it, send it again as a new message. The code works once.');
  assert.equal(ownerText(BRIDGE), undefined);
  assert.equal(ownerText({ ...BRIDGE, owner: { name: 'Sam Owner', linkedAt: 5 } }), 'Linked to Sam Owner on Telegram: messages from that account post as you.');
});

test('a code is gone at its expiry and once this bridge was linked after it was made', () => {
  assert.ok(!codeExpired(CODE, CODE.expiresAt - 1));
  assert.ok(codeExpired(CODE, CODE.expiresAt));
  assert.ok(!codeUsed(CODE, BRIDGE));
  assert.ok(codeUsed(CODE, { ...BRIDGE, owner: { name: 'Sam', linkedAt: 1_000_000 + 30_000 } }));
  assert.ok(!codeUsed(CODE, { ...BRIDGE, owner: { name: 'Sam', linkedAt: 999_999 } }), 'an older link is not this code');
  assert.ok(!codeUsed(CODE, { ...BRIDGE, id: 'br_2', owner: { name: 'Sam', linkedAt: 1_000_000 + 30_000 } }), 'another bridge');
});
