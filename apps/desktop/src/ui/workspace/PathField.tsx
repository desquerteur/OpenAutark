// The address slot of a file or folder tab: at rest the path (a right click offers the system's own app), on a click or
// Ctrl+L the editable field in the same box. Enter opens what the typed path holds in this tab; Escape puts the path back;
// both leave the keyboard in the pane. A path of a linked PC (B-076, `device`) stays that PC's.
// Owns: that field. Never: reads files (file-tabs.ts).

import { useEffect, useRef, useState } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import { toastError } from '../lib/toasts.ts';
import { openPathTab, pathMenu } from './file-tabs.ts';
import { pathFocus } from './pages.ts';
import { useSpace } from './space.ts';

/** Another path opened: its tab has a new field, and the one that had the keyboard is gone. */
const keepKeyboard = (space: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(`.workspace-pane[data-space="${space}"] .browser-address`)?.focus({ preventScroll: true }));

export function PathField(props: { id: string; path: string; device?: string }) {
  const { id, path, device } = props;
  const space = useSpace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(path);
  const field = useRef<HTMLInputElement>(null);
  const rest = useRef<HTMLButtonElement>(null);
  const leaving = useRef(false);
  const menu = useContextMenu(() => pathMenu(path, device));
  const asked = pathFocus.value;
  const handled = useRef(asked.ask);
  useEffect(() => { if (editing) { field.current?.focus({ preventScroll: true }); field.current?.select(); } else if (leaving.current) { leaving.current = false; rest.current?.focus({ preventScroll: true }); } }, [editing]);
  useEffect(() => {
    if (asked.space !== space || asked.ask === handled.current) return;
    handled.current = asked.ask;
    setDraft(path);
    setEditing(true);
    field.current?.focus({ preventScroll: true }); // already editing: the effect above does not run again
    field.current?.select();
  }, [asked]);
  const submit = (event: Event) => {
    event.preventDefault();
    leaving.current = true;
    setEditing(false);
    if (draft.trim() && draft.trim() !== path) void openPathTab(draft.trim(), id, space, device).then(() => keepKeyboard(space), (error: unknown) => toastError(error, 'Could not open this path'));
  };
  return (
    <form class="browser-address-form" onSubmit={submit}>
      {editing
        ? <input ref={field} class="browser-address" type="text" aria-label="Path" spellcheck={false} autocomplete="off" value={draft}
            onInput={(event) => setDraft(event.currentTarget.value)} onBlur={() => setEditing(false)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); leaving.current = true; setEditing(false); } }} />
        : <button ref={rest} type="button" class="browser-address browser-address-view" aria-label="Path" title={path} {...menu} onClick={() => { setDraft(path); setEditing(true); }}>
            <span class="browser-url">{path}</span>
          </button>}
    </form>
  );
}
