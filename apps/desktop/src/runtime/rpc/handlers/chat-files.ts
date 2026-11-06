// RPC handlers of B-050 for whole chats: chats.direct (K1 – the caller's default 1:1, found,
// adopted or created by runtime/chat/direct.ts; opening an archived one brings it back into the list)
// and chats.export (K8 – owner only: it writes a folder of this PC, given as an absolute path). The owner and their devices with 'chat' act as the
// owner ('human'); people of the organisation reach only person variants (rpc/table.ts addPerson –
// their chats.direct is in people/rpc-chats.ts).
// Owns: param checks and scope rules of these methods. Never: business logic (runtime/chat/direct.ts,
// runtime/chat-files/*).

import path from 'node:path';
import { HUMAN_ID } from '../../../shared/ids.ts';
import { exportChats } from '../../chat-files/export.ts';
import { findOrCreateDirect } from '../../chat/direct.ts';
import { bad, id, ids, input, onlyKeys, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';
import { rememberConversation } from './system.ts';

const CHAT = { capability: 'chat' } as const;

/** An absolute folder path of this PC (one line, no NUL character). */
function folderPath(value: string, key: string): string {
  if (value.includes('\u0000') || !path.isAbsolute(value)) bad(key, 'an absolute folder path');
  return path.resolve(value);
}

export function register(table: HandlerTable): void {
  table.add('chats.direct', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['memberId']);
    const memberId = id(o, 'memberId');
    if (memberId === HUMAN_ID) bad('memberId', 'someone other than you');
    const conversationId = findOrCreateDirect(ctx.services, HUMAN_ID, memberId, { createdBy: HUMAN_ID });
    if (ctx.services.chats.get(conversationId)?.archivedAt !== undefined) ctx.services.chats.unarchive(conversationId); // opened on purpose: back in the list
    rememberConversation(ctx.services, conversationId);
    return ctx.services.chats.summary(conversationId);
  }, CHAT);
  table.add('chats.export', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationIds', 'dir']);
    const conversationIds = [...new Set(ids(o, 'conversationIds', 500))];
    if (!conversationIds.length) bad('conversationIds', 'at least one chat id');
    const dir = optText(o, 'dir', { max: 1024 });
    return exportChats(ctx.services, { conversationIds, dir: dir === undefined ? undefined : folderPath(dir, 'dir') });
  });
}
