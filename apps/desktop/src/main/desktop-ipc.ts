// Maps the constructed main-side modules onto the IPC action table (IpcDeps of ipc.ts).
// Owns: which module answers which channel. Never: validation or trust (ipc.ts) and no
// electron value imports (the dialog/clipboard/shell functions are passed in).

import type { TitleBarLayout } from '../shared/api/desktop.ts';
import type { FileRef } from '../shared/model/system.ts';
import type { Capture } from './capture.ts';
import { pickAndUpload, pickFolder } from './files-pick.ts';
import type { DialogOptions } from './files-pick.ts';
import type { IpcDeps } from './ipc.ts';
import type { RendererLink } from './renderer-link.ts';
import type { PortLike } from './runtime/rpc-client.ts';
import type { RuntimeLink } from './runtime-link.ts';
import type { MediaArm } from './security.ts';
import type { DesktopUpdates } from './updates-wiring.ts';

export interface DesktopIpcParts<P extends PortLike> {
  windowContentsId(): number | null;
  link: RuntimeLink<P>;
  updates: DesktopUpdates;
  renderer: RendererLink;
  media: MediaArm;
  capture: Capture;
  showOpenDialog(options: DialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  clipboardWrite(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  titleBarLayout?(layout: TitleBarLayout): void;
  /** AF-014: the Explorer entry (explorer-menu.ts). */
  explorerMenu?(action: unknown): Promise<boolean>;
  log(line: string): void;
}

const UPLOAD_TIMEOUT_MS = 10 * 60_000; // large recordings are streamed into the blob store

export function desktopIpcDeps<P extends PortLike>(parts: DesktopIpcParts<P>): IpcDeps {
  const { link, updates, renderer } = parts;
  return {
    windowContentsId: parts.windowContentsId,
    runtime: { desktopPort: () => link.desktopPort(), status: () => link.status },
    updates: {
      state: () => updates.state(),
      apply: () => updates.apply(),
      defer: () => updates.defer(),
      setAutoDownload: enabled => updates.setAutoDownload(enabled),
      setRendererReady: ready => renderer.setReady(ready),
    },
    restartAck: (id, ok) => renderer.ack(id, ok),
    armMedia: kinds => parts.media.arm(kinds),
    capture: { window: () => parts.capture.windowDataUrl(), screen: () => parts.capture.screenDataUrl() },
    files: {
      pick: kind => pickAndUpload(kind, {
        showOpenDialog: parts.showOpenDialog,
        upload: (file): Promise<FileRef> => link.rpc.call('files.uploadPath', { path: file }, UPLOAD_TIMEOUT_MS),
      }),
      pickFolder: purpose => pickFolder(purpose, { showOpenDialog: parts.showOpenDialog }),
      open: async (id, reveal) => { await link.rpc.call('files.open', { id, reveal }); },
    },
    clipboardWrite: parts.clipboardWrite,
    openExternal: parts.openExternal,
    titleBarLayout: parts.titleBarLayout,
    explorerMenu: parts.explorerMenu, // AF-014
    online: () => link.power('online'), // B-044: the window's network came back (chat re-delivery in the runtime)
    log: parts.log,
  };
}
