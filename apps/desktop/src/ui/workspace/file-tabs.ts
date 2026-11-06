// The ways to a path in a surface: open a file tab or a folder tab (what the path holds decides), the docs behind file
// tabs (a doc with typed text stays when its tab goes) and the right-click menu of a path. Any part of the app calls these;
// a tab opens in `space`, else where `inPlaceOf` is shown, else where the frame says (pages.ts openPanel) – on the phone
// too, where it shows its PC's file. B-076: a path of a linked PC names it in `device`; reads and writes go there.
// Owns: those. Never: draws a tab (FileView.tsx, FolderView.tsx) or tab logic (pages.ts).

import '../../shared/api/methods-files.ts'; // the files.*Path method shapes (module augmentation)
import type { MenuSection } from '../lib/popover.tsx';
import { errorText, rpc, RpcError } from '../lib/rpc.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { FileDoc } from './file-doc.ts';
import { openPanel } from './pages.ts';

const docs = new Map<string, FileDoc>();
const docKey = (path: string, device?: string) => `${device ?? ''}\n${path}`;
/** The params naming the linked PC a path is on (none: this PC). */
export const onPc = (device?: string): { device?: string } => (device ? { device } : {});

export function docFor(path: string, device?: string): FileDoc {
  const key = docKey(path, device);
  let doc = docs.get(key);
  if (!doc) {
    doc = new FileDoc(path, {
      read: (at, since) => rpc.call('files.readPath', { path: at, ...(since === undefined ? {} : { since }), ...onPc(device) }),
      write: (at, text, base) => rpc.call('files.writePath', { path: at, text, ...(base === undefined ? {} : { base }), ...onPc(device) }),
      conflict: (error) => error instanceof RpcError && error.code === 'conflict',
      errorText,
    }, device);
    docs.set(key, doc);
  }
  return doc;
}

/** The file's tab is gone or not shown: nothing typed, nothing to keep. */
export function releaseDoc(doc: FileDoc): void {
  if (!doc.state.peek().dirty) docs.delete(docKey(doc.path, doc.device));
}

export function openFileTab(path: string, inPlaceOf?: string, space?: string, device?: string): void {
  openPanel({ kind: 'file', path, ...onPc(device) }, inPlaceOf, space);
}

export function openFolderTab(path: string, inPlaceOf?: string, space?: string, device?: string): void {
  openPanel({ kind: 'folder', path, ...onPc(device) }, inPlaceOf, space);
}

/** Opens what `path` holds as a tab; a path that holds nothing yet is a new file. Failures throw. */
export async function openPathTab(path: string, inPlaceOf?: string, space?: string, device?: string): Promise<void> {
  const read = await rpc.call('files.readPath', { path, ...onPc(device) });
  if (read.state === 'folder') openFolderTab(read.path, inPlaceOf, space, device);
  else openFileTab(read.path, inPlaceOf, space, device);
}

export function openWithSystem(path: string, reveal = false): void {
  rpc.call('files.openPath', { path, reveal, anywhere: true }).catch((error: unknown) => toastError(error, 'Could not open it'));
}

/** A path's right-click menu (a path of another PC: only its copy – the system's apps are this PC's). */
export function pathMenu(path: string, device?: string): MenuSection[] {
  const copy = { label: 'Copy path', onSelect: () => { navigator.clipboard.writeText(path).then(() => pushToast({ title: 'Copied', tone: 'info' }, 1500), (error: unknown) => toastError(error, 'Could not copy')); } };
  if (device) return [{ items: [copy] }];
  return [{ items: [
    { label: 'Open with system', onSelect: () => openWithSystem(path) },
    { label: 'Show in folder', onSelect: () => openWithSystem(path, true) },
    copy,
  ] }];
}
