// The message events of the external protocol (B-050 K8 d, docs/EXTERNAL_PROTOCOL.md): on GET /events
// and on /ws sockets of other programs (Hello client 'external', or a connector token) every
// message.created / message.updated payload also says who wrote it, in which chat and how loud –
// `author {id, kind, name}`, `chat {id, title}` (the title its reader sees) and `level`. The message
// itself is what the caller's scope may see already (rpc/scopes.ts visibleData).
// Owns: that enrichment and the connection wrapper that applies it. Never: widens what a scope sees.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { ClientScope } from '../../shared/api/protocol.ts';
import { messageLevel, type Message, type MessageLevel } from '../../shared/model/chat.ts';
import { chatTitleFor, memberNamer } from '../chat-files/names.ts';
import type { RuntimeServices } from '../contracts.ts';
import type { RpcConnection } from './types.ts';

export interface MessageView extends Message {
  author: { id: string; kind: Message['authorKind']; name: string };
  chat: { id: string; title: string };
  level: MessageLevel;
}

/** Who reads: the member id whose view of a chat's title applies. */
export function viewerOf(scope: ClientScope): string {
  if (scope.kind === 'external') return scope.memberId;
  if (scope.kind === 'person') return scope.personId;
  return HUMAN_ID;
}

export function messageView(s: RuntimeServices, message: Message, viewerId: string): MessageView {
  const nameOf = memberNamer(s);
  let title = '';
  try {
    const chat = s.chats.get(message.conversationId);
    if (chat) title = chatTitleFor(chat, s.chats.members(chat.id), viewerId, nameOf);
  } catch { /* the chat went meanwhile */ }
  return {
    ...message,
    author: { id: message.authorId, kind: message.authorKind, name: nameOf(message.authorId) },
    chat: { id: message.conversationId, title },
    level: messageLevel(message),
  };
}

/** The frame with a message event's payload enriched (other frames unchanged). */
export function viewFrame(s: RuntimeServices, frame: unknown, viewerId: string): unknown {
  const event = (frame as { event?: unknown } | null)?.event;
  if (event !== 'message.created' && event !== 'message.updated') return frame;
  const data = (frame as { data?: Message }).data;
  if (!data || typeof data !== 'object' || typeof data.conversationId !== 'string') return frame;
  try {
    return { event, data: messageView(s, data, viewerId) };
  } catch {
    return frame;
  }
}

/** A connection whose message events carry the external view. */
export function withMessageViews(connection: RpcConnection, services: () => RuntimeServices, scope: ClientScope): RpcConnection {
  const viewer = viewerOf(scope);
  return {
    send: (frame) => connection.send(viewFrame(services(), frame, viewer)),
    close: () => connection.close(),
    onMessage: (listener) => connection.onMessage(listener),
    onClose: (listener) => connection.onClose(listener),
  };
}
