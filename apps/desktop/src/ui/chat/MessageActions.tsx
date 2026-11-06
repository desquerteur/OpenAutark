// Message actions: the message's right-click (long-press) menu – Reply, Start thread (B-078: or Open thread), Copy, Edit,
// Remember why…, Delete, each only where
// it applies – and the inline editor. Reply sets the composer's reply (draft.ts setReply) for a finished
// text message; Edit and Delete are offered for the caller's own text messages only, where this connection
// may call them. Edit opens the inline editor in place (Esc cancels, Ctrl+Enter or Save saves; the message
// then shows "edited"); Remember why… (own text messages) opens its one-field dialog (RememberWhy.tsx); Delete asks
// first, the runtime leaves a "Message deleted" tombstone.
// Owns: the menu entries and the inline editor. Never: decides who may edit (the runtime refuses others'
// messages) or renders the message itself (MessageItem).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Message } from '../../shared/model/chat.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { personalText } from '../../shared/model/message-changes.ts';
import { confirm, type MenuItem, type MenuSection } from '../lib/ui.tsx';
import { modKey } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { setReply } from './composer/draft.ts';
import { offersRemember } from './remember.ts';
import { rememberTarget } from './RememberWhy.tsx';
import { isThread, startThread, threadsByAnchor } from './threads.ts';
import { conversationMap } from '../lib/store.ts';

/** The caller's own finished text message ('human' is the caller on every device) – the runtime's rule (chat/message-edits.ts). */
const own = (message: Message) => personalText(message) && message.authorId === HUMAN_ID && message.state === 'final';
const canReply = (message: Message) => message.kind === 'text' && message.state !== 'streaming' && can('messages.send');
const canEdit = (message: Message) => own(message) && message.body.trim().length > 0 && can('messages.edit');
const canDelete = (message: Message) => own(message) && can('messages.delete');

async function remove(message: Message): Promise<void> {
  const ok = await confirm({
    title: 'Delete message?', confirmLabel: 'Delete', danger: true,
    body: 'It is removed from this chat. Agents that already read it are told that it was deleted.',
  });
  if (!ok) return;
  try { await rpc.call('messages.delete', { id: message.id }); } catch (error) { toastError(error, 'Message not deleted'); }
}

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); pushToast({ title: 'Copied', tone: 'info' }, 1500); } catch (error) { toastError(error, 'Copy failed'); }
}

/** The message's menu: Reply, Copy, Edit, Remember why…, Delete – each only where it applies. */
export function messageMenu(message: Message, onEdit: () => void): MenuSection[] {
  const items: MenuItem[] = [];
  if (canReply(message)) items.push({ label: 'Reply', onSelect: () => setReply(message.conversationId, message.id) });
  // B-078: a thread on this message – never inside a thread (the thread itself answers it)
  const chat = conversationMap.peek().get(message.conversationId);
  if (canReply(message) && chat && !isThread(chat) && !chat.settings.system) {
    items.push({ label: threadsByAnchor.peek().has(message.id) ? 'Open thread' : 'Start thread', onSelect: () => void startThread(message) });
  }
  if (message.body && message.state !== 'streaming') items.push({ label: 'Copy', onSelect: () => void copy(message.body) });
  if (canEdit(message)) items.push({ label: 'Edit', onSelect: onEdit });
  if (can('references.remember') && offersRemember(message, HUMAN_ID)) items.push({ label: 'Remember why…', onSelect: () => { rememberTarget.value = message; } });
  if (canDelete(message)) items.push({ label: 'Delete', danger: true, onSelect: () => void remove(message) });
  return [{ items }];
}

/** The person's own message edited in place: Esc cancels, Ctrl+Enter (⌘+Enter) or Save saves. */
export function InlineEdit(props: { message: Message; onDone: () => void }) {
  const { message, onDone } = props;
  const [text, setText] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(innerHeight * 0.4))}px`;
  }, [text]);
  useEffect(() => { const el = field.current; el?.focus(); el?.setSelectionRange(el.value.length, el.value.length); }, []);

  const save = async () => {
    if (busy || !text.trim()) return;
    if (text === message.body) { onDone(); return; }
    setBusy(true);
    let saved = false;
    try { await rpc.call('messages.edit', { id: message.id, body: text }); saved = true; } catch (error) { toastError(error, 'Message not changed'); }
    setBusy(false);
    if (saved) onDone();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDone(); }
    else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
  };

  return (
    <div class="message-edit">
      <textarea ref={field} class="message-edit-input" rows={1} value={text} aria-label="Edit message" readOnly={busy}
        onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} onKeyDown={onKeyDown} />
      <div class="message-edit-actions">
        <span class="message-edit-hint">Esc to cancel · {modKey}Enter to save</span>
        <button type="button" class="button secondary" onClick={onDone}>Cancel</button>
        <button type="button" class="button primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save</button>
      </div>
    </div>
  );
}
