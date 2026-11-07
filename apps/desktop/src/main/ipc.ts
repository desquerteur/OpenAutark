// Every desktop IPC channel of src/shared/api/desktop.ts, behind the sender trust check (only
// our window's main frame at app://app; mini-app frames and anything else are refused).
// Invoke channels answer IpcResult envelopes; send channels from untrusted senders are dropped.
// Runtime ports: one live owner port per window and page lease. The preload sends its lease
// (random page id + a counter it moves only after a runtime restart/stop or a port it had to
// close), so a reload or a restart gets a new port, while a second request on a live lease – a
// page script reaching connect() again – is answered with an empty transfer ('in_use').
// Owns: channel → action wiring, argument validation and that port bookkeeping. Never: business
// state (that lives in the runtime, reached over RPC), imports electron (ipcMain-like object
// injected).

import { IPC } from '../shared/api/desktop.ts';
import type { IpcResult, PickKind, RuntimeStatus, TitleBarLayout } from '../shared/api/desktop.ts';
import type { FileRef, UpdateState } from '../shared/model/system.ts';
import * as args from './ipc-args.ts';
import { externalUrl, isTrustedSender } from './security.ts';
import type { MediaKind } from './security.ts';

export interface IpcEventLike {
  sender: { id: number; mainFrame?: unknown; postMessage?(channel: string, message: unknown, transfer?: unknown[]): void };
  /** WebFrameMain: `parent` is null for a main frame. */
  senderFrame?: { url: string; parent?: unknown } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...values: unknown[]) => Promise<unknown>): void;
  on(channel: string, listener: (event: IpcEventLike, ...values: unknown[]) => void): void;
}

export interface IpcDeps {
  /** webContents id of our window, null when it is closed. */
  windowContentsId(): number | null;
  runtime: { desktopPort(): Promise<unknown | null>; status(): RuntimeStatus };
  updates: {
    state(): UpdateState;
    apply(): Promise<UpdateState>;
    defer(): UpdateState;
    setAutoDownload(enabled: boolean): Promise<UpdateState>;
    setRendererReady(ready: boolean): void;
  };
  restartAck(id: number, ok: boolean): void;
  armMedia(kinds: MediaKind[]): void;
  capture: { window(): Promise<string>; screen(): Promise<string> };
  files: {
    pick(kind: PickKind): Promise<FileRef[]>;
    /** The purpose is checked where the dialog is built (files-pick.ts). */
    pickFolder(purpose: unknown): Promise<string | null>;
    open(fileId: string, reveal: boolean): Promise<void>;
  };
  clipboardWrite(text: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** AF-014: the Explorer entry ('state' | 'on' | 'off', checked in explorer-menu.ts); resolves whether it is on. */
  explorerMenu?(action: unknown): Promise<boolean>;
  /** The UI's layout for the native caption controls (main/title-bar.ts). */
  titleBarLayout?(layout: TitleBarLayout): void;
  /** B-044: the app window's network came back (navigator 'online'); main pushes host power 'online' to the runtime. */
  online?(): void;
  log?(line: string): void;
}

/** Electron facts → trust decision (exported for tests). */
export function trusted(event: IpcEventLike, windowContentsId: number | null): boolean {
  try {
    const frame = event.senderFrame ?? null;
    return isTrustedSender({
      contentsId: event.sender.id,
      isMainFrame: frame !== null && (frame === event.sender.mainFrame || frame.parent === null),
      frameUrl: frame?.url,
    }, windowContentsId);
  } catch {
    return false; // a disposed frame throws on access: never trusted
  }
}

const UNTRUSTED: IpcResult<never> = { ok: false, error: { code: 'forbidden', message: 'Untrusted request.' } };

/** The preload's page lease: 32 hex characters of page id, a dot, the restart counter. */
function isLease(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}\.\d{1,9}$/.test(value);
}

export function registerIpc(ipc: IpcMainLike, deps: IpcDeps): void {
  let refused = 0;
  const refuse = (channel: string) => {
    // Rate-limited: a misbehaving page must not flood the log.
    if (refused++ < 20) deps.log?.(`refused IPC ${channel} from an untrusted sender`);
  };

  const handle = (channel: string, action: (...values: unknown[]) => unknown) => {
    ipc.handle(channel, async (event, ...values) => {
      if (!trusted(event, deps.windowContentsId())) { refuse(channel); return UNTRUSTED; }
      try {
        const value = await action(...values);
        return { ok: true, value: value === undefined ? null : value } satisfies IpcResult<unknown>;
      } catch (error) {
        return args.ipcFailure(error);
      }
    });
  };

  const on = (channel: string, action: (event: IpcEventLike, ...values: unknown[]) => void) => {
    ipc.on(channel, (event, ...values) => {
      if (!trusted(event, deps.windowContentsId())) { refuse(channel); return; }
      try { action(event, ...values); } catch { /* invalid fire-and-forget input is dropped */ }
    });
  };

  // runtime connection: the port goes back to the asking renderer only, at most one per page
  // lease. A failure or refusal answers with an empty transfer (the reason as message), so the
  // preload's connect() rejects at once instead of after its timeout.
  let live: { contentsId: number; lease: string } | null = null;
  const answer = (event: IpcEventLike, reason: string) => {
    try { event.sender.postMessage?.(IPC.runtimePort, reason, []); } catch { /* window gone */ }
  };
  on(IPC.runtimeConnect, (event, lease) => {
    if (!isLease(lease)) { answer(event, 'bad_request'); return; }
    if (live && live.contentsId === event.sender.id && live.lease === lease) {
      if (refused++ < 20) deps.log?.('refused a second runtime port while the page holds a live one');
      answer(event, 'in_use');
      return;
    }
    const grant = { contentsId: event.sender.id, lease };
    live = grant;
    const release = () => { if (live === grant) live = null; };
    void Promise.resolve()
      .then(() => deps.runtime.desktopPort())
      .catch(error => {
        deps.log?.(`runtime port failed: ${error instanceof Error ? error.message : 'error'}`);
        return null;
      })
      .then(port => {
        const close = () => { try { (port as { close?(): void } | null)?.close?.(); } catch { /* already closed */ } };
        if (!trusted(event, deps.windowContentsId())) { release(); close(); return; }
        if (!port) { release(); answer(event, 'unavailable'); return; }
        try { event.sender.postMessage?.(IPC.runtimePort, null, [port]); } catch { release(); close(); }
      });
  });

  // updates
  handle(IPC.updateGet, () => deps.updates.state());
  handle(IPC.updateApply, () => deps.updates.apply());
  handle(IPC.updateDefer, () => deps.updates.defer());
  handle(IPC.updateAutoDownload, enabled => deps.updates.setAutoDownload(args.flag(enabled)));
  on(IPC.updateReady, (_event, ready) => deps.updates.setRendererReady(ready === true));
  on(IPC.prepareRestartAck, (_event, id, ok) => deps.restartAck(args.requestId(id), ok === true));

  // microphone / camera arming (a user gesture in the UI)
  handle(IPC.mediaArm, kinds => { deps.armMedia(args.mediaKinds(kinds)); });

  // host helpers
  handle(IPC.captureWindow, () => deps.capture.window());
  handle(IPC.captureScreen, () => deps.capture.screen());
  handle(IPC.filesPick, kind => deps.files.pick(args.pickKind(kind)));
  handle(IPC.filesPickFolder, purpose => deps.files.pickFolder(purpose));
  handle(IPC.explorerMenu, action => deps.explorerMenu ? deps.explorerMenu(action) : false); // AF-014
  handle(IPC.filesOpen, (id, reveal) => deps.files.open(args.fileId(id), args.optionalFlag(reveal)));
  handle(IPC.clipboardWrite, text => deps.clipboardWrite(args.clipboardText(text)));
  handle(IPC.openExternal, url => {
    const safe = externalUrl(url, { mailto: true });
    if (!safe) throw new args.IpcArgError('link');
    return deps.openExternal(safe);
  });

  // window chrome: anything but 'compact' is the column layout
  on(IPC.titleBarLayout, (_event, layout) => deps.titleBarLayout?.(layout === 'compact' ? 'compact' : 'columns'));

  // B-044: network back. A hidden window that shares the preload sends it too – dropped without a refusal line.
  ipc.on(IPC.online, event => {
    if (!trusted(event, deps.windowContentsId())) return;
    try { deps.online?.(); } catch { /* the runtime is down: this signal is lost; waiting chats take the next account, model or online event */ }
  });
}
