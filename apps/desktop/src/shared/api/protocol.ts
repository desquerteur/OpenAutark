// Wire protocol between clients (desktop UI, PWA, linked PCs, CLI, external agents) and
// the runtime. JSON messages over a MessagePort (desktop) or WebSocket (everything else).
// Owns: envelope shapes and topic names. Never: transport details (see runtime/rpc, ui/lib/rpc).

import type { WorkforceErrorData } from '../errors.ts';

export const PROTOCOL_VERSION = 1;

export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: WorkforceErrorData;
}

/** Server → client push. */
export interface RpcEvent {
  event: string; // see EventMap keys
  data: unknown;
}

export type RpcFrame = RpcRequest | RpcResponse | RpcEvent;

export function isRequest(frame: unknown): frame is RpcRequest {
  return typeof frame === 'object' && frame !== null && 'method' in frame && 'id' in frame;
}
export function isResponse(frame: unknown): frame is RpcResponse {
  return typeof frame === 'object' && frame !== null && 'id' in frame && !('method' in frame);
}
export function isEvent(frame: unknown): frame is RpcEvent {
  return typeof frame === 'object' && frame !== null && 'event' in frame;
}

/**
 * Subscription topics. A client only receives events for topics it subscribed to and is
 * allowed to see (PWA/phone devices are scoped; linked PCs get peer scopes).
 *   'chats'          conversation list changes, previews, unread, working indicators
 *   'chat:<id>'      messages + streaming deltas of one conversation
 *   'tasks'          task changes (board, For-you list, chat task panels)
 *   'org'            agents, activity, spaces
 *   'providers'      accounts, usage/quotas, model catalog
 *   'system'         settings, devices, updates, pwa, theme, feedback, notifications
 *   'runs:<agentId>' run + run item stream for the agent insight view
 *   'browser:<agentId>' live view of the agent's browser (MP8, owner; joined by browser.subscribe)
 */
export type Topic = 'chats' | 'tasks' | 'org' | 'providers' | 'system' | `chat:${string}` | `runs:${string}`
  | `browser:${string}`;

/**
 * What a paired phone/browser may do. A paired device gets todo, chat, tasks, settings and manage
 * (runtime/pwa/tokens.ts FULL_ACCESS); 'permissions' (secrets metadata, spend) only on a secure transport.
 *   todo        For-you list: answer to-dos, task updates, uploads, agent names,
 *               settings read – no chat content (drafts, reply notifications)
 *   chat        chats, messages, models/usage reads, modes, knowledge, skills read, feedback
 *               (write/list; sending the issue stays on the PC), dictation
 *   tasks       the task board and schedules list
 *   settings    appearance and notification settings
 *   manage      agents, spaces, schedules, model policies, skills save, run insight
 *   permissions secrets list/create, spend (secure transport only)
 */
export type DeviceCapability = 'todo' | 'chat' | 'tasks' | 'settings' | 'manage' | 'permissions';

/** Who is calling. Decided by the transport during the handshake, never by the client. */
export type ClientScope =
  /**
   * Desktop window / local CLI with the launch token: full access. `main` marks Electron main's own port (entry-electron).
   * AF-001 `agentId`: the local CLI an agent runs (wf with AUTARK_AGENT_TOKEN, checked by the transport – runtime/agents/
   * agent-token.ts): still full access, but what it writes into chats is that agent's (rpc/handlers/agent-send.ts).
   */
  | { kind: 'owner'; main?: true; agentId?: string }
  /**
   * PWA / phone. `secure` is set by the transport: true for loopback (incl. the local
   * `tailscale serve` https proxy) and tailnet peers that reached this PC's tailnet address;
   * absent or false on plain LAN http.
   */
  | { kind: 'device'; deviceId: string; capabilities: DeviceCapability[]; secure?: boolean }
  | { kind: 'peer'; deviceId: string } // linked PC runtime
  | { kind: 'agent'; agentId: string; runId: string } // MCP lease of a running agent
  /** C8: an external agent docked into one chat as member `memberId` (bridges/external-agents.ts). */
  | { kind: 'external'; memberId: string; conversationId: string; tokenId: string }
  /** F-52: a person of the organisation (not the owner) on one of their devices; `secure` as for devices (runtime/people). */
  | { kind: 'person'; personId: string; deviceId: string; tokenId: string; secure?: boolean };

/** First frame on a WebSocket connection. */
export interface Hello {
  protocol: number;
  token: string; // launch token, device token or peer session token
  client: 'desktop' | 'pwa' | 'peer' | 'cli' | 'external'; // 'external': C8 external agent
  deviceName?: string;
  /** AF-001: the agent's identity token (AGENT_TOKEN_ENV) beside the owner token – wf run by an agent writes as that agent. */
  agent?: string;
}

/** AF-001: the variable the app sets in an agent's shells and engine processes; its wf sends it as Hello `agent`. */
export const AGENT_TOKEN_ENV = 'AUTARK_AGENT_TOKEN';
