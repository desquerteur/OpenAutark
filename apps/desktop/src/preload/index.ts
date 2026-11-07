// Preload of the app window (bundled to app/preload.cjs, runs sandboxed with context isolation).
// Exposes `window.workforce` = WorkforceDesktopApi (src/shared/api/desktop.ts) over IPC.
// Runtime port: contextBridge cannot pass MessagePorts, so connect() asks main for a port and
// re-posts it to the page with window.postMessage. The main-world wrapper (main-world.ts)
// swallows that message in a capture listener registered before any page script and hands the
// port only to the connector the UI claimed at boot (src/ui/lib/runtime-port.ts); the public
// connect() rejects after the claim. Each request carries this page's lease (a random page id
// plus a counter that moves only when the old port is gone: runtime restart or stop, or a port
// that arrived too late and was closed); main hands out one live port per lease (ipc.ts).
// Owns: IPC calls/listeners (incl. the window's 'online' event, B-044), envelope unwrapping and the lease. Never: holds business state,
// logic or secrets – every action is checked again in main (sender trust + argument validation).

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';
import { IPC, PORT_MESSAGE, TITLE_BAR_HEIGHT } from '../shared/api/desktop.ts';
import type { IpcResult, NavigateRequest, PickKind, RuntimeStatus, WorkforceDesktopApi } from '../shared/api/desktop.ts';
import type { FileRef, UpdateState } from '../shared/model/system.ts';
import { installMainWorld } from './main-world.ts';
import { WORKSPACE_BROWSER, type BrowserKeyEvent, type HistoryEntry, type SideSpaces, type WorkspaceBrowserPage, type WorkspaceCapture } from '../shared/api/workspace-browser.ts';

const CONNECT_TIMEOUT_MS = 60_000; // runtime boot (≤ 30 s) plus a restart backoff
const PORT_ARRIVAL_MS = 5_000;

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = await ipcRenderer.invoke(channel, ...args) as IpcResult<T> | undefined;
  if (result && result.ok === true) return result.value;
  const error = new Error(result?.error?.message ?? 'The app could not do this.') as Error & { code?: string };
  error.code = result?.error?.code ?? 'internal';
  throw error;
}

function listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event: IpcRendererEvent, ...args: unknown[]) => {
    try { listener(...(args as A)); } catch (error) { console.error(`[workforce] ${channel} listener failed`, error); }
  };
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.removeListener(channel, wrapped); };
}

// ------------------------------------------------------------------ runtime port

/** Random hex of `bytes` bytes (Web Crypto of the page; no Node APIs in a sandboxed preload). */
function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
}

const pageId = randomHex(16); // a reload runs this preload again: a new page, a new lease
let leaseCount = 0;
/** The data the preload posts with a real port: only the main-world wrapper knows it. */
const PORT_TAG = `${PORT_MESSAGE}:${randomHex(16)}`;
let guarded = false; // the main-world wrapper is installed (else the plain contract applies)

interface PendingConnect { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
const connects: PendingConnect[] = [];

ipcRenderer.on(IPC.runtimeStatus, (_event, status: RuntimeStatus | undefined) => {
  // The runtime process is gone, and so is every port it served: the next request may get one.
  if (status?.state === 'restarting' || status?.state === 'stopped') leaseCount += 1;
});

ipcRenderer.on(IPC.runtimePort, (event, reason: unknown) => {
  const port = event.ports[0];
  const pending = connects.shift();
  if (!pending) {
    // The asker timed out; this port is closed unused, so the next request needs a new lease.
    if (port) { port.close(); leaseCount += 1; }
    return;
  }
  clearTimeout(pending.timer);
  if (!port) {
    pending.reject(new Error(reason === 'in_use' ? 'The runtime connection is already open.' : 'The runtime is not running.'));
    return;
  }
  window.postMessage(guarded ? PORT_TAG : PORT_MESSAGE, '*', [port]);
  pending.resolve();
});

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    const pending: PendingConnect = {
      resolve,
      reject,
      timer: setTimeout(() => {
        const index = connects.indexOf(pending);
        if (index >= 0) connects.splice(index, 1);
        reject(new Error('The runtime is not running.'));
      }, CONNECT_TIMEOUT_MS),
    };
    connects.push(pending);
    ipcRenderer.send(IPC.runtimeConnect, `${pageId}.${leaseCount}`);
  });
}

// ------------------------------------------------------------------ prepare restart

const restartHandlers = new Set<() => Promise<void> | void>();

ipcRenderer.on(IPC.prepareRestart, async (_event, requestId: unknown) => {
  let ok = true;
  try {
    await Promise.all([...restartHandlers].map(handler => handler()));
  } catch {
    ok = false;
  }
  ipcRenderer.send(IPC.prepareRestartAck, requestId, ok);
});

// B-044: the network came back. Main's process has no such event; main forwards it to the runtime as host power 'online'
// (chat re-delivery, runtime/agents/redelivery.ts). Main takes it from the app window only.
window.addEventListener('online', () => { ipcRenderer.send(IPC.online); });

// ------------------------------------------------------------------ the API

const api: WorkforceDesktopApi = {
  workspaceBrowser: {
    command: command => invoke<WorkspaceBrowserPage[]>(WORKSPACE_BROWSER.command, command),
    onChanged: listener => listen<[WorkspaceBrowserPage[]]>(WORKSPACE_BROWSER.changed, listener),
    layout: () => invoke<SideSpaces>(WORKSPACE_BROWSER.layout),
    onLayout: listener => listen<[SideSpaces]>(WORKSPACE_BROWSER.layoutChanged, listener),
    capture: id => invoke<WorkspaceCapture>(WORKSPACE_BROWSER.capture, id),
    history: request => invoke<HistoryEntry[]>(WORKSPACE_BROWSER.history, request),
    onKey: listener => listen<[BrowserKeyEvent]>(WORKSPACE_BROWSER.key, listener), // a browser shortcut pressed inside a page, or the page menu's Send page to chat
  },
  platform: process.platform,
  titleBarHeight: TITLE_BAR_HEIGHT,
  setTitleBarLayout: layout => { ipcRenderer.send(IPC.titleBarLayout, layout === 'compact' ? 'compact' : 'columns'); },
  connect,
  onRuntime: listener => listen<[RuntimeStatus]>(IPC.runtimeStatus, listener),
  updates: {
    state: () => invoke<UpdateState>(IPC.updateGet),
    apply: () => invoke<UpdateState>(IPC.updateApply),
    defer: () => invoke<UpdateState>(IPC.updateDefer),
    setAutoDownload: enabled => invoke<UpdateState>(IPC.updateAutoDownload, enabled === true),
    setReady: ready => { ipcRenderer.send(IPC.updateReady, ready === true); },
  },
  onUpdate: listener => listen<[UpdateState]>(IPC.updateState, listener),
  onPrepareRestart: handler => {
    if (typeof handler !== 'function') return () => {};
    restartHandlers.add(handler);
    return () => { restartHandlers.delete(handler); };
  },
  armMedia: kinds => invoke<void>(IPC.mediaArm, kinds),
  capture: {
    window: () => invoke<string>(IPC.captureWindow),
    screen: () => invoke<string>(IPC.captureScreen),
  },
  files: {
    pick: (kind: PickKind) => invoke<FileRef[]>(IPC.filesPick, kind),
    pickFolder: purpose => invoke<string | null>(IPC.filesPickFolder, purpose),
    pathOf: (file: unknown) => { try { return webUtils.getPathForFile(file as File); } catch { return ''; } }, // AF-014: a dropped folder
    openPath: (fileId, reveal) => invoke<void>(IPC.filesOpen, fileId, reveal === true),
  },
  clipboard: { writeText: text => invoke<void>(IPC.clipboardWrite, text) },
  openExternal: url => invoke<void>(IPC.openExternal, url),
  explorerMenu: action => invoke<boolean>(IPC.explorerMenu, action), // AF-014
  onNavigate: listener => listen<[NavigateRequest]>(IPC.navigate, listener),
};

try {
  contextBridge.executeInMainWorld({ func: installMainWorld, args: [api, PORT_MESSAGE, PORT_TAG, PORT_ARRIVAL_MS] });
  guarded = true;
} catch (error) {
  // Without the wrapper the port travels as plain PORT_MESSAGE and nothing guards it.
  console.error('[workforce] main-world bridge failed; exposing the plain API without the port guard', error);
}
if (!guarded) contextBridge.exposeInMainWorld('workforce', api);
