// AF-016 – the chat's queued messages as a compact list right above the composer (only while something is queued). A
// head line: "Queued · N", why it waits when it is paused (the person's Pause, an error, an agent's question, a Stop) and
// Pause / Resume. One row per prompt, the next one first: a grip to drag it to another place (pointer – mouse, pen,
// touch – or the arrow keys on the focused grip), its number, a one-line preview (a click edits it in place: Enter
// saves, Shift+Enter a new line, Esc cancels), its files and level, then Send now, Edit and Delete. Files stay with
// their prompt. A drag shows the new order while it runs and saves it on release (queue.move); a failed call reloads.
// Owns: the list's markup, the drag and the inline edit. Never: when a prompt goes out (the runtime) or the composer.

import { useEffect, useRef, useState } from 'preact/hooks';
import { moveItem, promptPreview, type QueuedPrompt } from '../../../shared/model/prompt-queue.ts';
import { Icon } from '../../lib/ui.tsx';
import { dropIndex, loadQueue, pausedText, queueCall, queueFor, sendQueuedNow } from './queue.ts';

function EditField(props: { item: QueuedPrompt; onDone: (body?: string) => void }) {
  const [text, setText] = useState(props.item.body);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  const finish = (body?: string) => { if (done.current) return; done.current = true; props.onDone(body); };
  useEffect(() => { const field = ref.current; field?.focus(); field?.setSelectionRange(field.value.length, field.value.length); }, []);
  return (
    <textarea ref={ref} class="queue-edit" value={text} rows={Math.min(6, Math.max(1, text.split('\n').length))} aria-label="Edit queued message"
      onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(text); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(); }
      }}
      onBlur={() => finish(text)} />
  );
}

export function QueueList(props: { conversationId: string }) {
  const { conversationId } = props;
  const queue = queueFor(conversationId).value;
  const [editing, setEditing] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => { void loadQueue(conversationId); }, [conversationId]);
  if (!queue.items.length) return null;

  const reorder = async (id: string, index: number) => {
    const current = queueFor(conversationId).peek();
    queueFor(conversationId).value = { ...current, items: moveItem(current.items, id, index) }; // at once; the answer confirms
    if (!(await queueCall('queue.move', { conversationId, id, index }, 'Could not move it'))) void loadQueue(conversationId);
  };
  const save = (item: QueuedPrompt, body?: string) => {
    setEditing(null);
    if (body === undefined || body.trim() === item.body.trim()) return;
    if (!body.trim() && !item.attachments.length) return; // empty text: kept as it was (Delete removes it)
    void queueCall('queue.update', { conversationId, id: item.id, body }, 'Could not save the change');
  };

  const startDrag = (event: PointerEvent, item: QueuedPrompt, from: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const grip = event.currentTarget as HTMLElement;
    try { grip.setPointerCapture(event.pointerId); } catch { /* a synthetic pointer */ }
    const mids = [...(listRef.current?.querySelectorAll<HTMLElement>('.queue-row') ?? [])].map((row) => { const box = row.getBoundingClientRect(); return box.top + box.height / 2; });
    const startY = event.clientY;
    let over = from;
    const move = (next: PointerEvent) => { over = dropIndex(mids, from, next.clientY - startY); setDrag({ id: item.id, over }); };
    const end = () => {
      grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', end); grip.removeEventListener('pointercancel', end);
      setDrag(null);
      if (over !== from) void reorder(item.id, over);
    };
    grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
    setDrag({ id: item.id, over: from });
  };
  const gripKey = (event: KeyboardEvent, item: QueuedPrompt, index: number) => {
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (!step) return;
    event.preventDefault();
    const to = index + step;
    if (to < 0 || to >= queue.items.length) return;
    void reorder(item.id, to).then(() => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-queue-id="${item.id}"] .queue-grip`)?.focus()));
  };

  const shown = drag ? moveItem(queue.items, drag.id, drag.over) : queue.items;
  const paused = pausedText(queue);
  return (
    <section class={`queue-list${queue.paused ? ' paused' : ''}`} aria-label="Queued messages">
      <div class="queue-head">
        <Icon name="queue" size={15} />
        <span class="queue-title">Queued</span>
        <span class="queue-count tabular">{queue.items.length}</span>
        {paused && <span class="queue-paused" title={queue.paused?.note ?? paused}>{paused}</span>}
        <span class="queue-spacer" />
        {queue.paused
          ? <button type="button" class="queue-toggle" onClick={() => void queueCall('queue.resume', { conversationId }, 'Could not resume')}><Icon name="play" size={13} />Resume</button>
          : <button type="button" class="queue-toggle" onClick={() => void queueCall('queue.pause', { conversationId }, 'Could not pause')}><Icon name="pause" size={13} />Pause</button>}
      </div>
      <ol class="queue-rows" ref={listRef}>
        {shown.map((item, index) => (
          <li key={item.id} class={`queue-row${drag?.id === item.id ? ' dragging' : ''}${editing === item.id ? ' editing' : ''}`} data-queue-id={item.id}>
            <button type="button" class="queue-grip" aria-label={`Move message ${index + 1} – drag, or use the arrow keys`} title="Drag to reorder"
              onPointerDown={(event) => startDrag(event, item, index)} onKeyDown={(event) => gripKey(event, item, index)}>
              <Icon name="dots-six-vertical" size={14} />
            </button>
            <span class="queue-index tabular">{index + 1}</span>
            {editing === item.id
              ? <EditField item={item} onDone={(body) => save(item, body)} />
              : <button type="button" class="queue-text" title={item.body} onClick={() => setEditing(item.id)}>{promptPreview(item.body) || (item.attachments.length ? 'Files only' : '')}</button>}
            {item.priority === 'important' && <span class="queue-badge important" title="Important">!</span>}
            {item.silent && <span class="queue-badge" title="Silent"><Icon name="bell-slash" size={12} /></span>}
            {item.attachments.length + (item.secrets?.length ?? 0) > 0 && (
              <span class="queue-badge" title={item.attachments.map((file) => file.name).join(', ') || 'Secrets'}><Icon name="paperclip" size={12} />{item.attachments.length + (item.secrets?.length ?? 0)}</span>
            )}
            <span class="queue-actions">
              <button type="button" class="icon-button small" aria-label="Send now" title="Send now" onClick={() => void sendQueuedNow(conversationId, item.id)}><Icon name="arrow-up" size={14} /></button>
              <button type="button" class="icon-button small" aria-label="Edit" title="Edit" onClick={() => setEditing(item.id)}><Icon name="pencil-simple" size={14} /></button>
              <button type="button" class="icon-button small" aria-label="Delete" title="Delete" onClick={() => void queueCall('queue.remove', { conversationId, id: item.id }, 'Could not delete it')}><Icon name="trash" size={14} /></button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
