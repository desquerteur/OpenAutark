// One side tab's DevTools protocol connection – the tab's own webContents.debugger (the
// workspace browser already attaches it for the color scheme; this shares that attachment and attaches
// only when nobody did), with commands that time out, event fan-out, and the driver's isolated world:
// its script on every new document, a binding only that world can call, and evaluation in it.
// Owns: the connection, the domains it enables and the world. Never: imports electron (fakes in tests),
// detaches the debugger (others use it too) or evaluates in the page's own world (except eval, on request).

import { pageScript } from './page-script.ts';

export interface DebuggerLike {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, commandParams?: any, sessionId?: string): Promise<any>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

export interface ImageLike {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality?: string }): ImageLike;
  toJPEG(quality: number): Buffer;
}

/** The part of a WebContents the driver uses. */
export interface ContentsLike {
  readonly debugger: DebuggerLike;
  isDestroyed(): boolean;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  getZoomFactor?(): number;
  isDevToolsOpened?(): boolean;
  capturePage(rect?: { x: number; y: number; width: number; height: number }, opts?: { stayHidden?: boolean }): Promise<ImageLike>;
}

/** A failure the agent reads as one sentence (with the refusal flags of the result). */
export class SideError extends Error {
  personActive?: boolean;
  constructor(message: string, flags: { personActive?: boolean } = {}) {
    super(message);
    if (flags.personActive) this.personActive = true;
  }
}

export const WORLD = 'workforce-side';
export const BINDING = '__wfSideReport';
const COMMAND_MS = 10_000;
/** Kept response bodies per tab (Network.getResponseBody), small: the person's browsing pays for it. */
const NETWORK_BUFFER = { maxTotalBufferSize: 4 * 1024 * 1024, maxResourceBufferSize: 512 * 1024 };

export const DEVTOOLS_BUSY = 'The DevTools of this tab hold the page right now – close them (F12) and try again.';

type Listener = (params: any) => void;

export class TabCdp {
  readonly contents: ContentsLike;
  /** The main frame's id (Page.getFrameTree, then main-frame navigations). */
  mainFrame = '';
  private readying: Promise<void> | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  /** Our world's execution contexts: id → frame id. */
  private readonly worlds = new Map<number, string>();
  private closed = false;
  private readonly onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string) => {
    if (sessionId) return; // a child target's session (not ours)
    this.track(method, params as any);
    for (const listener of [...(this.listeners.get(method) ?? [])]) {
      try { listener(params); } catch { /* one listener's bug never stops the others */ }
    }
  };
  private readonly onDetach = () => { this.readying = null; this.worlds.clear(); };

  constructor(contents: ContentsLike) {
    this.contents = contents;
    contents.debugger.on('message', this.onMessage);
    contents.debugger.on('detach', this.onDetach);
  }

  /** Attached, domains on, our world's script and binding in place (once per attachment). */
  ready(): Promise<void> {
    if (this.closed || this.contents.isDestroyed()) return Promise.reject(new SideError('This tab was closed.'));
    this.readying ??= this.setup().catch((error: unknown) => { this.readying = null; throw error; });
    return this.readying;
  }

  private async setup(): Promise<void> {
    const dbg = this.contents.debugger;
    if (!dbg.isAttached()) {
      try { dbg.attach('1.3'); } catch { throw new SideError(DEVTOOLS_BUSY); }
    }
    await Promise.all([
      this.raw('Page.enable'), this.raw('Runtime.enable'), this.raw('Log.enable'), this.raw('Network.enable', NETWORK_BUFFER),
    ]);
    const tree = await this.raw('Page.getFrameTree') as { frameTree?: { frame?: { id?: string } } };
    this.mainFrame = tree.frameTree?.frame?.id ?? '';
    await this.raw('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await this.raw('Page.addScriptToEvaluateOnNewDocument', { source: pageScript(BINDING), worldName: WORLD, runImmediately: true });
  }

  private track(method: string, params: any): void {
    if (method === 'Runtime.executionContextCreated') {
      const context = params?.context;
      if (context?.name === WORLD && typeof context.id === 'number') this.worlds.set(context.id, String(context.auxData?.frameId ?? ''));
    } else if (method === 'Runtime.executionContextDestroyed') this.worlds.delete(params?.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') this.worlds.clear();
    else if (method === 'Page.frameNavigated' && params?.frame && !params.frame.parentId) this.mainFrame = String(params.frame.id ?? this.mainFrame);
  }

  /** Is this context our world in the main frame (the person's reports with coordinates come from there)? */
  isTopWorld(contextId: number): boolean {
    return this.worlds.get(contextId) === this.mainFrame;
  }

  private raw(method: string, params?: object, ms = COMMAND_MS): Promise<any> {
    if (this.contents.isDestroyed()) return Promise.reject(new SideError('This tab was closed.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SideError(this.contents.isDevToolsOpened?.()
        ? 'The page did not answer in time – it may be paused in its DevTools.'
        : 'The page did not answer in time – it may be busy; try again.')), ms);
      let sent: Promise<any>;
      try { sent = this.contents.debugger.sendCommand(method, params); } catch (error) { clearTimeout(timer); reject(error); return; }
      sent.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
    });
  }

  /** A command once ready. */
  async send<T = any>(method: string, params?: object, ms = COMMAND_MS): Promise<T> {
    await this.ready();
    return this.raw(method, params, ms) as Promise<T>;
  }

  on(method: string, listener: Listener): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  /** Our world's context in the main frame (made now when the document has none yet). */
  async world(): Promise<number> {
    await this.ready();
    let found = 0;
    for (const [id, frame] of this.worlds) if (frame === this.mainFrame) found = id;
    if (found) return found;
    const made = await this.raw('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: WORLD }) as { executionContextId: number };
    this.worlds.set(made.executionContextId, this.mainFrame);
    await this.raw('Runtime.evaluate', { expression: pageScript(BINDING), contextId: made.executionContextId });
    return made.executionContextId;
  }

  /** Evaluates in our world and returns the value (JSON-able). */
  async inWorld<T>(expression: string, ms = COMMAND_MS): Promise<T> {
    const contextId = await this.world();
    const out = await this.raw('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true }, ms) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'The page script failed.');
    return out.result?.value as T;
  }

  /** Calls a function on a node resolved in our world (`this` = the node), returning its value. */
  async callOn<T>(objectId: string, fn: string, args: unknown[] = []): Promise<T> {
    const out = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true }) as { result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } };
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text ?? 'The page script failed.');
    return out.result?.value as T;
  }

  dispose(): void {
    this.closed = true;
    this.listeners.clear();
    try { this.contents.debugger.removeListener('message', this.onMessage); this.contents.debugger.removeListener('detach', this.onDetach); } catch { /* gone */ }
  }
}
