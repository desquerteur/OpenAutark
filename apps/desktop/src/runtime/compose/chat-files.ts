// Composition of B-050 K8 (a): the derived chat mirror in <data>/chats (chat-files/mirror.ts) –
// always on, no setting; its start-up backfill runs on its own lane after the folder index.
// Owns: this wiring and its stop. Never: behaviour, timers or polling.

import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import { ChatMirror, chatMirrorOf } from '../chat-files/mirror.ts';
import { ROOT_CHATS } from '../root/layout.ts';

export function createChatMirror(s: RuntimeServices): ChatMirror {
  const mirror = new ChatMirror({ services: () => s, root: path.join(s.paths.data, ROOT_CHATS) });
  mirror.start();
  return mirror;
}

/** Stop step: writes what is pending, ends the backfill (its stamps resume it at the next start). */
export function stopChatMirror(s: Pick<RuntimeServices, 'db'>): Promise<void> | undefined {
  return chatMirrorOf(s)?.stop();
}
