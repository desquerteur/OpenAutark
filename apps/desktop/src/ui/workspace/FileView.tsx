// Pane tab › a file: one plain monospace field over the whole page area and one fixed line under it – the dirty dot in
// its own cell, the status words and the Reload cell (file-doc.ts says what they say). The field is not bound to the
// text, so a keystroke in a 1 MB file redraws nothing and the field's own undo keeps working. A file that is no text or
// very large says so and offers Open with system; a right click on the line offers it for any file. B-076: a file of a
// linked PC (`device`) is read and saved there – while that PC is offline its one line says so – and the field scrolls
// in step with the same tab elsewhere (view-sync.ts, by its top line).
// Owns: the field and the line. Never: saves or decides anything itself (file-doc.ts).

import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import { fileSize } from '../lib/format.ts';
import { modKey } from '../lib/platform.ts';
import { Icon, Spinner } from '../lib/ui.tsx';
import { fileStatus, POLL_MS } from './file-doc.ts';
import { docFor, openFolderTab, openWithSystem, pathMenu, releaseDoc } from './file-tabs.ts';
import { writeArea } from './NotesView.tsx';
import { useSpace } from './space.ts';
import { useScrollPosition } from './view-sync.ts';

function NoEditor(props: { path: string; text: string; device?: string }) {
  return (
    <div class="workspace-start">
      <Icon name="file" size={24} />
      <p>{props.text}</p>
      {!props.device && <button type="button" class="button secondary" onClick={() => openWithSystem(props.path)}>Open with system</button>}
    </div>
  );
}

export function FileView(props: { id: string; path: string; device?: string }) {
  const { id, path, device } = props;
  const space = useSpace();
  const doc = useMemo(() => docFor(path, device), [path, device]);
  const state = doc.state.value;
  const area = useRef<HTMLTextAreaElement>(null);
  const menu = useContextMenu(() => pathMenu(path, device));
  useEffect(() => {
    void doc.open();
    const timer = setInterval(() => void doc.poll(), POLL_MS);
    return () => { clearInterval(timer); releaseDoc(doc); };
  }, [doc]);
  useLayoutEffect(() => { if (area.current) writeArea(area.current, doc.text); }, [doc, state.revision, state.phase]);
  useEffect(() => { if (state.phase === 'folder') openFolderTab(path, id, space, device); }, [state.phase]);
  useScrollPosition(id, area, state.phase === 'text' ? state.revision : -1, true);

  const size = fileSize(state.size);
  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void doc.save(); }
  };
  if (state.phase === 'binary') return <div class="pane-view"><NoEditor path={path} device={device} text={`This file is not text (${size}).`} /></div>;
  if (state.phase === 'large') return <div class="pane-view"><NoEditor path={path} device={device} text={`This file is too large to edit here (${size}).`} /></div>;
  return (
    <div class="pane-view pane-file" onKeyDown={onKeyDown}>
      {state.phase === 'text'
        ? <textarea ref={area} class="pane-notes-field file-field" aria-label="File text" wrap="off" spellcheck={false} autocomplete="off" onInput={(event) => doc.edit(event.currentTarget.value)} />
        : <div class="pane-stage">{state.phase === 'failed' ? <p class="pane-note">{state.error}</p> : <Spinner label="Loading file" />}</div>}
      <div class={`pane-foot${state.error ? ' is-error' : ''}`} {...menu}>
        <span class={`file-dot${state.dirty ? ' is-dirty' : ''}`} role="img" aria-label={state.dirty ? 'Not saved' : 'Saved'} />
        <span class="pane-foot-text" role="status" aria-live="polite">{state.phase === 'text' ? fileStatus(state, size, modKey) : ''}</span>
        <span class="pane-foot-action">{state.changed && <button type="button" class="button secondary" onClick={() => void doc.load()}>Reload</button>}</span>
      </div>
    </div>
  );
}
