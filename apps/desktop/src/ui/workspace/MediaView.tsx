// Pane tab › Media: one stored file (a media library row or a chat file, by its id) or a file on this
// PC (by its path, stored first) – an image fitted into the page area, a video or recording in a
// player (streamed, never autoplayed), a PDF's text head, any other file as its icon and name. One
// line under it: the name, its facts ("1280×720 · 0:42 · 3.2 MB") and Open on the PC. A right click
// offers Open and Show in folder. B-076: a file of a linked PC (`device`) is stored there and its bytes
// come here (one line says so while that PC is offline); a video's second follows the same tab
// elsewhere when someone seeks or pauses (view-sync.ts).
// Owns: that view. Never: describes, tags, segments or deletes files (an agent does that on request).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileRef } from '../../shared/model/system.ts';
import { openPath } from '../blocks/host.ts';
import { MediaImage, MediaPlayer } from '../blocks/ui/Media.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { platform } from '../lib/platform.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { toastError } from '../lib/toasts.ts';
import { Icon, Spinner, type MenuSection } from '../lib/ui.tsx';
import { onPc } from './file-tabs.ts';
import { mediaFacts, viewKind } from './media-facts.ts';
import { nameTab } from './pages.ts';
import { useSpace } from './space.ts';
import { useTimePosition } from './view-sync.ts';

/** A file of a linked PC that could not be had is asked for again after this long. */
const RETRY_MS = 5000;

export function MediaView(props: { id: string; fileId?: string; path?: string; device?: string }) {
  const { id, fileId, path, device } = props;
  const space = useSpace();
  const stageRef = useRef<HTMLDivElement>(null);
  const [file, setFile] = useState<FileRef | null>(null);
  const [failed, setFailed] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = fileId ? rpc.call('files.get', { id: fileId }) : rpc.call('files.uploadPath', { path: path ?? '', ...onPc(device) });
    load.then((ref) => { if (!alive) return; setFailed(''); setFile(ref); nameTab(id, ref.name, space); }, (error: unknown) => {
      if (!alive) return;
      setFailed(errorText(error));
      if (device) retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS); // that PC may be back by then
    });
    return () => { alive = false; if (retry) clearTimeout(retry); };
  }, [fileId, path, device, attempt]); // a tab's file never changes (its id names it): the view is drawn anew for another
  useTimePosition(id, stageRef);

  const canOpen = platform === 'desktop' && !device && (path ? can('files.openPath') : can('files.open'));
  const open = (reveal: boolean) => {
    const done = path ? openPath(path, reveal) : file ? rpc.call('files.open', { id: file.id, reveal }) : Promise.resolve();
    void Promise.resolve(done).catch((error: unknown) => toastError(error, "Couldn't open the file"));
  };
  const menu = useContextMenu((): MenuSection[] => canOpen && file ? [{ items: [
    { label: 'Open', onSelect: () => open(false) },
    { label: 'Show in folder', onSelect: () => open(true) },
  ] }] : []);

  const kind = file ? viewKind(file.mime, file.name) : 'file';
  let stage;
  if (!file) stage = failed ? <p class="pane-note">{failed}</p> : <Spinner label="Loading file" />;
  else if (kind === 'image') stage = <MediaImage src={file.id} fileId={file.id} alt={file.name} />;
  else if (kind === 'video' || kind === 'audio') stage = <MediaPlayer src={file.id} fileId={file.id} kind={kind} />;
  else if (kind === 'pdf' && file.textPreview) stage = <pre class="pane-media-text">{file.textPreview}</pre>;
  else stage = <div class="workspace-start"><Icon name="file" size={24} /><p>{file.name}</p></div>;

  return (
    <div class={`pane-view pane-media kind-${kind}`} {...menu}>
      <div class="pane-stage" ref={stageRef}>{stage}</div>
      <div class="pane-foot">
        <span class="pane-foot-text" title={file?.name}>{file ? [file.name, mediaFacts(file)].filter(Boolean).join(' · ') : ''}</span>
        {canOpen && <button type="button" class="button secondary pane-foot-button" disabled={!file} onClick={() => open(false)}>Open</button>}
      </div>
    </div>
  );
}
