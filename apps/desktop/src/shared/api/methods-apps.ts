// RPC contract part (connectors, shared/model/apps.ts). Connectors are files the AI edits (<data>/connectors/,
// skill connect-apps); the RPC only reads their state and starts a sign-in. Handlers:
// runtime/rpc/handlers/connected-apps.ts, delegating to services.apps ('unavailable' while it is missing).
// Merged into Methods by module augmentation (methods.ts is at its size limit).
// Owns: these method shapes. Never: behaviour.

import type { ConnectedApp } from '../model/apps.ts';

declare module '../api/methods.ts' {
  interface Methods {
    /** Every connector with its state (no tokens, no header or env values). */
    'apps.list': { params: void; result: ConnectedApp[] };
    /** Connects again; an MCP server that needs a sign-in opens it in the system browser ('waiting'). */
    'apps.reconnect': { params: { id: string }; result: ConnectedApp };
  }
}

export {};
