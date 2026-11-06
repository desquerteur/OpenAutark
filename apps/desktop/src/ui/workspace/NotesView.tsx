// Pane tab › Notes: a chat's shared notes that the person and the chat's agents (chat.notes.* tools)
// edit – one plain text field over the whole page area and one quiet line under it (Saving…, or who
// changed them last). Saving and loading are notes-sync.ts: last write wins, a change by someone else
// is loaded while nothing typed waits. Text arriving from others is written into the field without
// moving the cursor. Read-only on a connection without notes.save.
// Owns: the field and the line. Never: merges, history or the save rules (notes-sync.ts).

import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { listTime } from '../lib/format.ts';
import { errorText, rpc, RpcError } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { agentName } from '../lib/store.ts';
import { Spinner } from '../lib/ui.tsx';
import { NotesSync, type NotesState } from './notes-sync.ts';
import '../../shared/api/methods-notes.ts'; // the notes.* method shapes (module augmentation)

function statusLine(state: NotesState): string {
  if (state.error) return state.error;
  if (state.saving || state.dirty) return 'Saving…';
  if (!state.version) return 'Everyone in this chat can edit these notes.';
  return `Updated by ${agentName(state.updatedBy ?? '')}${state.updatedAt ? ` · ${listTime(state.updatedAt)}` : ''}`;
}

/** Writes arriving text into the field, keeping the cursor where it was (clamped to the new text). */
export function writeArea(area: HTMLTextAreaElement, text: string): void {
  if (area.value === text) return;
  const { selectionStart, selectionEnd, scrollTop } = area;
  area.value = text;
  area.setSelectionRange(Math.min(selectionStart, text.length), Math.min(selectionEnd, text.length));
  area.scrollTop = scrollTop;
}

export function NotesView(props: { conversationId: string }) {
  const { conversationId } = props;
  const sync = useMemo(() => new NotesSync({
    get: () => rpc.call('notes.get', { conversationId }),
    save: (text, baseVersion) => rpc.call('notes.save', { conversationId, text, baseVersion }),
    conflict: (error) => error instanceof RpcError && error.code === 'conflict',
    errorText,
  }), [conversationId]);
  const area = useRef<HTMLTextAreaElement>(null);
  const state = sync.state.value;
  useEffect(() => {
    if (!can('notes.get')) return;
    void sync.load();
    const offEvent = rpc.on('notes.updated', (event) => { if (event.conversationId === conversationId) sync.changed(event.version); });
    const offOpen = rpc.onOpen(() => void sync.load());
    return () => { offEvent(); offOpen(); void sync.flush(); }; // leaving the tab saves what was typed
  }, [sync]);
  useLayoutEffect(() => { if (area.current) writeArea(area.current, state.text); }, [state.text, state.loaded]);

  if (!can('notes.get')) return <div class="pane-view"><div class="workspace-start"><p>Notes are not available on this connection.</p></div></div>;
  return (
    <div class="pane-view pane-notes">
      {state.loaded
        ? <textarea ref={area} class="pane-notes-field" aria-label="Notes" placeholder="Notes for everyone in this chat" readOnly={!can('notes.save')} spellcheck
            onInput={(event) => sync.edit(event.currentTarget.value)}
            onFocus={() => { if (!sync.state.peek().dirty) void sync.load(); }}
            onBlur={() => void sync.flush()}
            onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void sync.flush(); } }} />
        : <div class="pane-stage">{state.error ? <p class="pane-note">{state.error}</p> : <Spinner label="Loading notes" />}</div>}
      <p class={`pane-foot${state.error ? ' is-error' : ''}`} role="status" aria-live="polite"><span class="pane-foot-text">{state.loaded ? statusLine(state) : ''}</span></p>
    </div>
  );
}
