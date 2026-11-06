// Read on one device, read everywhere (D3, owner 06.11.2026: the numbers on new messages "sollen synchron sein"): when
// the owner's read cursor of a chat reaches its end – read here, on a phone, or on another of my PCs (the cursor travels
// with the chat, devices/sync/tables.ts) – and this PC pushed a notification for that chat, every phone it holds
// (its own subscriptions and those of my other PCs, devices/sync/held-push.ts) gets one silent push `{clear: 'chat:<id>'}`;
// the service worker closes that chat's notices (ui/pwa/sw.ts). The PC that pushed a notice is the one that clears it.
// A phone whose service worker is still 0.3.x's knows no `clear` and shows every push: so the clear also carries the
// pushed notice itself (its tag, id, title, body, silent) – that worker finds the open notice with the same id and
// shows nothing, or at worst puts the same notice back quietly once, instead of stacking blank "Autark" notices.
// Apple's push service (the iPhone web app) gets no clear at all: iOS revokes a subscription that receives a push
// without a notice (isApplePush).
// Owns: remembering which chats this PC pushed a notice for, and the clear. Never: pushes a person's devices, or a to-do's
// notice (a to-do stays until it is done), a clear to Apple's push service, or logs an endpoint.

import { HUMAN_ID } from '../../shared/ids.ts';
import type { RuntimeServices } from '../contracts.ts';
import { heldSubs, localSubs, ownerHeld, ownKey, pushTo, type PushFetch } from '../devices/sync/held-push.ts';
import { pushTarget } from './push.ts';

/** The last notice pushed for a chat, as far as an older service worker needs it to replace it in place. */
export interface PushedNote { id?: string; title: string; body: string }

/** At most this many chats are remembered with an open notice (the oldest is forgotten first). */
const OPEN_MAX = 200;

/** The chats whose notice this PC pushed and that are not read yet; a cursor at the end of one clears it. Returns the off switch. */
export function startReadClear(s: Pick<RuntimeServices, 'db' | 'bus' | 'host' | 'clock' | 'log' | 'notifications'>, options: { fetch?: PushFetch } = {}): () => void {
  const open = new Map<string, PushedNote>();
  const offChannel = s.notifications.addChannel?.((pushed) => {
    if (!pushed.conversationId || pushed.taskId) return;
    open.delete(pushed.conversationId);
    open.set(pushed.conversationId, { id: pushed.id, title: pushed.title, body: pushed.body });
    if (open.size > OPEN_MAX) open.delete(open.keys().next().value as string);
  });
  const offBus = s.bus.on('conversation.upserted', (summary) => {
    const id = summary?.id;
    if (!id || !open.has(id)) return;
    const row = s.db.get<{ read_seq: number; last_seq: number }>(
      'SELECT m.read_seq, c.last_seq FROM members m JOIN conversations c ON c.id = m.conversation_id WHERE m.conversation_id = ? AND m.member_id = ?', [id, HUMAN_ID]);
    if (!row || Number(row.read_seq) < Number(row.last_seq)) return;
    const note = open.get(id);
    open.delete(id);
    void clearChat(s, id, options.fetch, note).catch((error: unknown) => s.log.debug('notice not cleared', { error: String((error as Error)?.message ?? error) }));
  });
  return () => { offChannel?.(); offBus(); };
}

/**
 * Apple's push service (an iPhone web app): iOS revokes a subscription that receives pushes without showing a notice,
 * so it gets no clear – the iPhone app closes read chats' notices itself when it comes to the front (ui/pwa/install.ts).
 */
export function isApplePush(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    return host === 'push.apple.com' || host.endsWith('.push.apple.com');
  } catch {
    return false;
  }
}

/** One silent push that closes the notices of chat `id` on every phone of the owner this PC holds (not iPhones). */
export async function clearChat(s: Pick<RuntimeServices, 'db' | 'host' | 'clock' | 'log'>, id: string, fetch?: PushFetch, note?: PushedNote): Promise<number> {
  const own = await ownKey(s);
  const now = s.clock.now();
  const targets = [...(own ? localSubs(s.db, own.pub, now) : []).filter((sub) => !sub.person), ...ownerHeld(s.db, heldSubs(s.db), now)]
    .filter((sub) => !isApplePush(sub.endpoint));
  const { url, tag } = pushTarget({ kind: 'reply', conversationId: id });
  const older = note ? { tag, url, title: note.title, body: note.body, silent: true, ...(note.id ? { id: note.id } : {}) } : {};
  return pushTo(s, targets, { clear: tag, ...older }, { fetch });
}
