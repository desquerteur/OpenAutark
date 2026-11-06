// Chat details › Notes: the way into the chat's shared notes – the document every member edits (the owner, the
// people of the chat, its agents). One row: "Notes" with who changed them last; a click opens the notes in the side
// pane (side-pane.ts), also before anyone wrote any. Only on connections that may read notes; the runtime decides
// which chats. It reads the notes meta only (notes.meta, again after every notes.updated), never the text.
// Owns: this row. Never: edits notes (the pane's notes tab does).

import { useEffect, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../../shared/model/chat.ts';
import type { NotesMeta } from '../../../shared/model/notes.ts';
import '../../../shared/api/methods-notes.ts'; // the notes.* method shapes (module augmentation)
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { agentName } from '../../lib/store.ts';
import { showNotes } from '../side-pane.ts';
import { notesLine } from './notes-line.ts';

export function Notes(props: { chat: ConversationSummary }) {
  const { chat } = props;
  const allowed = can('notes.meta');
  const [meta, setMeta] = useState<NotesMeta | null>(null);
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    const load = () => { rpc.call('notes.meta', { conversationId: chat.id }).then((next) => { if (alive) setMeta(next); }).catch(() => undefined); };
    setMeta(null);
    load();
    const off = rpc.on('notes.updated', (update) => { if (update.conversationId === chat.id) load(); });
    return () => { alive = false; off(); };
  }, [chat.id, allowed]);
  if (!allowed) return null;
  const line = notesLine(meta, agentName);
  return (
    <section class="details-section" aria-label="Notes">
      <button type="button" class="details-action details-notes" onClick={() => showNotes(chat.id)}>
        <span class="details-notes-text">
          <span>Notes</span>
          {line && <span class="details-notes-meta">{line}</span>}
        </span>
      </button>
    </section>
  );
}
