// Connectors (connected apps): the person's real services reached through MCP servers or a mailbox. They are plain
// files – <data>/connectors/mcp.json (the usual "mcpServers" map) and mail.json ("mailboxes") – which the AI edits
// (skill connect-apps); the runtime applies every change and agents use the tools as `app.<id>.<tool>`
// (runtime/apps). Public shapes only: never a token, header or env value.
// Owns: these shapes and their small constant lists. Never: behaviour.

/** How the runtime talks to the connector: an MCP server over http or stdio, or a mailbox over IMAP/SMTP. */
export type AppTransport = 'http' | 'stdio' | 'mail';
/**
 * 'ok' connected (tools known) · 'connecting' a test or tool listing runs · 'waiting' the browser sign-in is open ·
 * 'signin' it needs a sign-in or a key (`error` says how) · 'error' the last attempt failed (`error` says why) ·
 * 'off' "disabled": true in its file.
 */
export type AppStatus = 'ok' | 'connecting' | 'waiting' | 'signin' | 'error' | 'off';
export const APP_STATUSES: readonly AppStatus[] = ['ok', 'connecting', 'waiting', 'signin', 'error', 'off'];

export interface ConnectedApp {
  /** Short stable id, lowercase [a-z0-9-] (≤ 24), from its key in the file: part of every tool name `app.<id>.<tool>`. */
  id: string;
  /** Its key in mcp.json / mail.json. */
  name: string;
  transport: AppTransport;
  /** What the person recognises: the host of an http server, a command's name, a mailbox's address. */
  address: string;
  status: AppStatus;
  /** Reason for 'error' / 'signin' (never a token, header or response body). */
  error?: string;
  /** How many tools the agents get. */
  tools: number;
  /** Up to 40 tool names. */
  toolNames: string[];
  /** While 'waiting': the sign-in page (the system browser opened it). */
  signInUrl?: string;
  /** AF-005: the agents (ids or names) that may use it, as its file names them; missing = every agent. */
  agents?: string[];
}

export interface MailServer { host: string; port: number; tls: 'implicit' | 'starttls' }

/** Longest app id (tool names stay ≤ 64 characters on every engine). */
export const APP_ID_MAX = 24;
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
