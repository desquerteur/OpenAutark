// The transport-neutral connection the RPC server talks to. Transports (WebSocket in http/,
// the desktop MessagePort, in-process clients and tests) adapt to this shape.
// Owns: the RpcConnection interface, frame decoding (objects, JSON text or UTF-8 bytes – one
// frame per message) and two small adapters (message ports, in-memory pairs).
// Never: authentication (the transport decides the ClientScope before attaching) or dispatch.

/** Max JSON text accepted for one frame (transports enforce their own, smaller limits). */
const MAX_FRAME_CHARS = 64 * 1024 * 1024;

/** Frames arrive as objects (MessagePort) or JSON text (WebSocket: string or bytes); undefined when unreadable. */
export function parseFrame(data: unknown): unknown {
  let value = data;
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value);
  if (typeof value === 'string') {
    if (value.length > MAX_FRAME_CHARS) return undefined;
    try { return JSON.parse(value); } catch { return undefined; }
  }
  return value;
}

export interface RpcConnection {
  /** Sends one frame (an object; string-based transports serialize it). Must not throw when closed. */
  send(frame: unknown): void;
  close(): void;
  onMessage(listener: (data: unknown) => void): void;
  onClose(listener: () => void): void;
}

/**
 * Structural view of a message port: Electron's MessagePortMain (`on('message', e => e.data)`),
 * Node's worker MessagePort (`on('message', value => value)`) or a DOM-style port.
 */
export interface PortLike {
  postMessage(message: unknown): void;
  close(): void;
  start?(): void;
  on?(event: 'message' | 'close', listener: (event?: unknown) => void): unknown;
  addEventListener?(event: 'message' | 'close', listener: (event: unknown) => void): void;
}

/** MessageEvent-like wrappers carry the frame in `data` next to `ports`. */
function unwrap(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event && ('ports' in event || 'target' in event)) {
    return (event as { data: unknown }).data;
  }
  return event;
}

/** Adapts a message port (desktop window ↔ runtime) to an RpcConnection. */
export function portConnection(port: PortLike): RpcConnection {
  const messageListeners = new Set<(data: unknown) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) {
      try { listener(); } catch { /* a failing listener must not block the others */ }
    }
  };
  const deliver = (event: unknown): void => {
    if (closed) return;
    const data = unwrap(event);
    for (const listener of messageListeners) listener(data);
  };
  if (port.on) {
    port.on('message', deliver);
    port.on('close', finish);
  } else if (port.addEventListener) {
    port.addEventListener('message', deliver);
    port.addEventListener('close', finish);
  }
  port.start?.();
  return {
    send(frame) {
      if (closed) return;
      try { port.postMessage(frame); } catch { finish(); }
    },
    close() {
      if (closed) return;
      try { port.close(); } catch { /* already gone */ }
      finish();
    },
    onMessage(listener) { messageListeners.add(listener); },
    onClose(listener) { closeListeners.add(listener); },
  };
}

/** The client end of an in-memory pair (in-process callers and tests). */
export interface MemoryClient {
  /** Frames the server sent, in order. */
  readonly received: unknown[];
  send(frame: unknown): void;
  close(): void;
  onFrame(listener: (frame: unknown) => void): () => void;
  readonly closed: boolean;
}

/**
 * Two connected ends: `server` goes to RpcServer.attach, `client` sends requests and records
 * replies/events. Delivery is asynchronous (microtask) in both directions, like a real port.
 */
export function memoryConnection(): { server: RpcConnection; client: MemoryClient } {
  const serverListeners = new Set<(data: unknown) => void>();
  const closeListeners = new Set<() => void>();
  const frameListeners = new Set<(frame: unknown) => void>();
  const received: unknown[] = [];
  let closed = false;
  const shut = (): void => {
    if (closed) return;
    closed = true;
    for (const listener of closeListeners) {
      try { listener(); } catch { /* ignore */ }
    }
  };
  const server: RpcConnection = {
    send(frame) {
      if (closed) return;
      queueMicrotask(() => {
        received.push(frame);
        for (const listener of frameListeners) listener(frame);
      });
    },
    close: shut,
    onMessage(listener) { serverListeners.add(listener); },
    onClose(listener) { closeListeners.add(listener); },
  };
  const client: MemoryClient = {
    received,
    send(frame) {
      if (closed) return;
      queueMicrotask(() => { for (const listener of serverListeners) listener(frame); });
    },
    close: shut,
    onFrame(listener) { frameListeners.add(listener); return () => frameListeners.delete(listener); },
    get closed() { return closed; },
  };
  return { server, client };
}
