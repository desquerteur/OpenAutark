// RPC handlers: the media library – list/search media of all chats or one chat (by name, description and
// tags), set the description/tags of a stored file, and (MM6) what still uses a file and deleting it.
// Owns: param checks and scope rules (media.list and media.describe: owner + devices with the 'chat'
// capability – a paired phone is the owner's own device; descriptions are data, not instructions, and are
// always authored by the human; media.uses and media.delete: owner only).
// Never: media logic (MediaService via extras.media) or file bytes.

import { HUMAN_ID } from '../../../shared/ids.ts';
import type { MediaFilter, MediaKind, MediaPatch } from '../../../shared/model/media.ts';
import { fileId, input, onlyKeys, optId, optIds, optNum, optOneOf, optStrings, optText } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;
const MEDIA_KINDS: readonly MediaKind[] = ['image', 'audio', 'video', 'document', 'other'];

export function register(table: HandlerTable): void {
  table.add('media.list', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['conversationId', 'kind', 'text', 'limit']);
    const filter: MediaFilter = {};
    const conversationId = optId(o, 'conversationId');
    if (conversationId) filter.conversationId = conversationId;
    const kind = optOneOf(o, 'kind', MEDIA_KINDS);
    if (kind) filter.kind = kind;
    const search = optText(o, 'text', { max: 200, allowEmpty: true })?.trim();
    if (search) filter.text = search;
    const limit = optNum(o, 'limit', { min: 1, max: 500 });
    if (limit !== undefined) filter.limit = limit;
    return ctx.extras.media.list(filter);
  }, CHAT);

  table.add('media.describe', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['fileId', 'description', 'tags']);
    const patch: MediaPatch = {};
    const description = optText(o, 'description', { max: 4000, allowEmpty: true, multiline: true });
    if (description !== undefined) patch.description = description;
    const tags = optStrings(o, 'tags', { maxItems: 30, max: 60 });
    if (tags) patch.tags = tags;
    return ctx.extras.media.describe(fileId(o), patch, HUMAN_ID);
  }, CHAT);

  // MM6: what still uses a file, and deleting it for good (with the confirmed messages that
  // show it). Owner only – like deleting a chat, removing stored files stays on the PC.
  table.add('media.uses', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['fileId']);
    return ctx.extras.media.uses(fileId(o));
  });

  table.add('media.delete', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['fileId', 'messageIds']);
    const id = fileId(o);
    await ctx.extras.media.delete(id, { messageIds: optIds(o, 'messageIds', 100) ?? [] });
    return { ok: true as const };
  });
}
