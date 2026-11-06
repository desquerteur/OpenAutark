// Pane tab › Media without a file: the stored media as one list with a search over names, descriptions and tags (media.list
// with `text`), newest first and fresh through media.upserted. A row opens that file in a tab of its own in this
// surface's space (space.ts).
// Owns: the search field, a short debounce and the list. Never: edits or deletes files (an agent does that on request).

import { useEffect, useState } from 'preact/hooks';
import type { MediaInfo } from '../../shared/model/media.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { EmptyState, Icon, Spinner, type IconName } from '../lib/ui.tsx';
import { mediaFacts } from './media-facts.ts';
import { Row } from './NewTabPage.tsx';
import { openPanel } from './pages.ts';
import { useSpace } from './space.ts';

const MEDIA_ICON: Record<MediaInfo['kind'], IconName> = { image: 'image', video: 'play', audio: 'play', document: 'file-text', other: 'file' };
const DEBOUNCE_MS = 200;

export function MediaLibrary() {
  const space = useSpace();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<MediaInfo[] | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let alive = true;
    const words = text.trim();
    const load = () => rpc.call('media.list', { limit: 100, ...(words ? { text: words } : {}) })
      .then((list) => { if (alive) { setFiles(list); setFailed(''); } }, (error: unknown) => { if (alive) setFailed(errorText(error)); });
    const timer = setTimeout(() => void load(), words ? DEBOUNCE_MS : 0);
    const offRow = rpc.on('media.upserted', () => void load());
    return () => { alive = false; clearTimeout(timer); offRow(); };
  }, [text]);
  return (
    <div class="pane-view">
      <div class="pane-search">
        <Icon name="magnifying-glass" size={14} />
        <input type="search" class="pane-search-field" aria-label="Search media" placeholder="Search media" value={text} onInput={(event) => setText(event.currentTarget.value)} />
      </div>
      <div class="new-tab">
        {failed ? <EmptyState>{failed}</EmptyState>
          : !files ? <Spinner />
          : !files.length ? <EmptyState>{text.trim() ? 'No media found.' : 'No files yet.'}</EmptyState>
          : <ul class="new-tab-list">{files.map((file) => <Row key={file.fileId} icon={MEDIA_ICON[file.kind]} label={file.name} hint={mediaFacts(file)} onClick={() => openPanel({ kind: 'media', fileId: file.fileId, name: file.name }, undefined, space)} />)}</ul>}
      </div>
    </div>
  );
}
