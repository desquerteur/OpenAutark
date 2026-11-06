// `file` block: a deliverable. Desktop: Open / Show in folder (by path, or the stored copy by
// fileId). Phone/PWA: the file name and Download when the runtime stored the file (fileId) –
// never the PC's path.
// Owns: file row rendering and the download. Never: opens paths outside the host's own checks
// (main decides) or shows an absolute path off the desktop.

import { useState } from 'preact/hooks';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import { rpc } from '../../lib/rpc.ts';
import { toastError } from '../../lib/toasts.ts';
import { isFileId, openPath, platform } from '../host.ts';
import { Inline } from '../markdown.tsx';
import { s } from './util.ts';

/** files.read sends at most this much in one frame (runtime READ_MAX_BYTES). */
const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? '';

async function download(fileId: string, name: string): Promise<void> {
  const { dataBase64, mime } = await rpc.call('files.read', { id: fileId, maxBytes: DOWNLOAD_MAX_BYTES });
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000); // one-shot: give the browser time to start the download
}

export function FileBlock(props: { block: UiBlock }) {
  const path = s(props.block.path);
  const fileId = isFileId(s(props.block.fileId)) ? s(props.block.fileId) : '';
  const fileName = baseName(path);
  const name = s(props.block.label) || fileName || 'File';
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try { await work(); } catch (error) { toastError(error, failure); } finally { setBusy(false); }
  };
  const open = (reveal: boolean) => act(
    () => (path ? openPath(path, reveal) : rpc.call('files.open', { id: fileId, reveal })),
    "Couldn't open the file",
  );
  const desktop = platform === 'desktop';
  return (
    <div class="b-file">
      <Icon name="file" size={20} />
      <div class="b-file-text">
        <div class="b-file-name" title={desktop ? path || name : name}>{name}</div>
        {props.block.note !== undefined && <Inline text={s(props.block.note)} class="b-step-sub" />}
      </div>
      {desktop && (path || fileId) && (
        <div class="b-file-actions">
          <button type="button" class="button secondary" disabled={busy} onClick={() => open(false)}>Open</button>
          {path && <button type="button" class="button ghost" disabled={busy} onClick={() => open(true)}>Show in folder</button>}
        </div>
      )}
      {!desktop && fileId && (
        <div class="b-file-actions">
          <button type="button" class="button secondary" disabled={busy} onClick={() => act(() => download(fileId, fileName || name), "Couldn't download the file")}>Download</button>
        </div>
      )}
    </div>
  );
}
