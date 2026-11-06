// "Same id ⇒ update in place" across messages (web-genui §7.5): a later ```ui block with the
// same `id` in the same chat replaces the earlier one, which then shows "Updated below".
// Only an agent's or the system's message may update a block in place: a person's, a bridged
// contact's or an external agent's (C8) block never collapses an agent's ask or approval block.
// Owns: a per-chat registry of the newest (seq, index) per block id, fed by rendered messages.
// Never: deletes history – earlier versions stay in their messages, just collapsed.

import { signal } from '@preact/signals';
import type { Message } from '../../shared/model/chat.ts';

interface Latest { seq: number; index: number }

/** chatId → blockId → newest occurrence. One signal so readers re-render on change. */
const registry = signal<Map<string, Map<string, Latest>>>(new Map());

/** Records the ids a message contains (registerMessageIds, once its author may update blocks). */
function registerIds(conversationId: string, seq: number, ids: Array<{ id: string; index: number }>): void {
  if (!ids.length) return;
  const chats = registry.value;
  const chat = chats.get(conversationId) ?? new Map<string, Latest>();
  let changed = !chats.has(conversationId);
  for (const { id, index } of ids) {
    const known = chat.get(id);
    if (!known || seq > known.seq || (seq === known.seq && index > known.index)) {
      chat.set(id, { seq, index });
      changed = true;
    }
  }
  if (changed) {
    const next = new Map(chats);
    next.set(conversationId, chat);
    registry.value = next;
  }
}

/** Authors whose blocks may update an earlier block with the same id in place. */
const UPDATES_IN_PLACE: ReadonlySet<Message['authorKind']> = new Set<Message['authorKind']>(['agent', 'system']);

/** Records a message's block ids (MessageBody after parsing) – only when its author may update blocks in place. */
export function registerMessageIds(message: Pick<Message, 'conversationId' | 'seq' | 'authorKind'>, ids: Array<{ id: string; index: number }>): void {
  if (UPDATES_IN_PLACE.has(message.authorKind)) registerIds(message.conversationId, message.seq, ids);
}

/** True when a newer block with the same id exists later in the chat. */
export function isSuperseded(conversationId: string, id: string | undefined, seq: number, index: number): boolean {
  if (!id) return false;
  const latest = registry.value.get(conversationId)?.get(id);
  return Boolean(latest && (latest.seq > seq || (latest.seq === seq && latest.index > index)));
}
