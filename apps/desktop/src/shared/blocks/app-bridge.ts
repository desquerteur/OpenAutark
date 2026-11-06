// Contract of the ```app mini-tool bridge (web-genui.md §7.9): the messages a sandboxed
// app iframe and its host exchange over postMessage. Follows MCP Apps (SEP-1865) JSON-RPC 2.0
// names so foreign MCP App views work unchanged; Workforce extras are host tools (`wf_*`).
// Owns: method/tool names and payload shapes. Implementations: src/ui/sandbox/wf.ts (inside
// the frame) and the host bridge in the chat block renderer. Payloads are JSON except
// wf_upload's `data`: a Blob posted as a structured-clone handle (X03; its types, names and
// limits: shared/blocks/app-files.ts).
// Never: lets a bridge message count as a permission or approval (they are "via mini-app"
// user events at most).

export const APP_BRIDGE_PROTOCOL = '2026-01-26';

/** JSON-RPC methods (app → host requests unless noted). */
export const APP_METHODS = {
  initialize: 'ui/initialize', // → { hostContext, hostCapabilities }
  initialized: 'ui/notifications/initialized', // app → host notification
  toolsCall: 'tools/call', // { name, arguments } → { content, structuredContent? }
  message: 'ui/message', // { role: 'user', content: { type: 'text', text } }
  displayMode: 'ui/request-display-mode', // { mode: 'inline' | 'fullscreen' }
  sizeChanged: 'ui/notifications/size-changed', // app → host notification { width, height }
  hostContextChanged: 'ui/notifications/host-context-changed', // host → app notification (theme flip)
  ping: 'ping', // host → app request (MCP base protocol) → {}; the host's CPU-watchdog heartbeat
} as const;

/** Host tools the Workforce host exposes to every app (called through tools/call). */
export const APP_TOOLS = {
  event: 'wf_event', // { name, data } → delivered to the authoring agent as [ui-event …]
  complete: 'wf_complete', // { data } → resolves the to-do the app belongs to
  stateGet: 'wf_state_get', // {} → { state } (persisted per block id)
  stateSet: 'wf_state_set', // { state } → { ok }
  mermaid: 'wf_mermaid', // { source } → { svg } rendered by the host's cached renderer
  upload: 'wf_upload', // { data: Blob, name? } → { fileId, name, mime, size } (to-do apps only; the Blob is a structured-clone handle, not JSON)
  record: 'wf_record', // { mode: audio|video, maxSeconds?, script? } → stored file, only after the human records and sends in the host
  rpc: 'wf_rpc', // { method, params } → { result }: the app's RPC, for views of <data>/pages only (ui/workspace/PageView.tsx)
  listen: 'wf_listen', // { event } → then the host posts `event/<name>` with its data: the app's events, for those views only
} as const;

export interface AppHostContext {
  theme: 'light' | 'dark';
  styles?: { variables?: Record<string, string> }; // --wf-* tokens
  displayMode?: 'inline' | 'fullscreen';
  platform?: 'desktop' | 'mobile' | 'web';
  containerDimensions?: { maxHeight?: number; width?: number };
  locale?: string;
}

export interface AppInitializeResult {
  protocolVersion: string;
  hostContext: AppHostContext;
  hostCapabilities?: Record<string, unknown>;
}

/** Size caps the host enforces (same numbers as web-genui.md §3.4). */
export const APP_BRIDGE_LIMITS = {
  messageBytes: 64 * 1024,
  messagesPerSecond: 5,
  actionsPerMinute: 30,
} as const;
