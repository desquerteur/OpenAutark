// Connectors – the seams between the parts of runtime/apps/:
//   connectors.ts  the files <data>/connectors/mcp.json and mail.json → Connector entries
//   client/*       the MCP client (Streamable HTTP and stdio)            → connectMcp()
//   mail/*         a mailbox as an in-process connection of the same shape
//   oauth/*        MCP authorization (discovery, registration, PKCE)     → AppOAuth
//   tools.ts       MCP tools → Workforce ToolDefs `app.<id>.<tool>`       → appToolDefs()
//   service.ts     applies the files, connects, signs in, registers tools
// Owns: these shapes and error classes. Never: behaviour, or a secret value in a field that is logged or shown.

import type { AppTransport, ConnectedApp, MailServer } from '../../shared/model/apps.ts';

// ------------------------------------------------------------------ MCP wire shapes (client side)

export interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A tool as the server lists it (untrusted: names, descriptions and annotations are only hints). */
export interface McpToolDef {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; title?: string; mimeType?: string; description?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface McpCallResult {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  /** The negotiated version ('2025-06-18', '2025-11-25', '2026-07-28' …). */
  protocolVersion: string;
  /** Untrusted server text – never put into a prompt as an instruction. */
  instructions?: string;
}

// ------------------------------------------------------------------ client (client/*)

export interface HttpTarget {
  kind: 'http';
  url: string;
  /** Extra headers per request (Authorization from AppOAuth or a stored token; static imported headers). */
  headers?: () => Promise<Record<string, string>>;
}

export interface StdioTarget {
  kind: 'stdio';
  command: string;
  args: string[];
  /** Resolved env (vault values already filled in by the service; never logged). */
  env?: Record<string, string>;
  cwd?: string;
}

/** B-053: a mailbox (runtime/apps/mail/*): IMAP for reading/drafts/folders/IDLE, SMTP for sending. */
export interface MailTarget {
  kind: 'mail';
  address: string;
  imap: { host: string; port: number; tls: 'implicit' | 'starttls' };
  smtp: { host: string; port: number; tls: 'implicit' | 'starttls' };
  /** Login user (usually the address) and the app password / token, resolved from the vault. */
  login: () => Promise<{ user: string; password: string }>;
  /** Called on new mail in INBOX while the connection holds IDLE (the service wakes the mailbox's agent). */
  onNewMail?: (info: { count: number; from?: string; subject?: string }) => void;
  /** B-059: where the IDLE watcher keeps its high-water mark (mail/idle.ts), so mail that came while it was away wakes once. */
  mark?: { get(): MailMark | undefined; set(mark: MailMark): void };
}

/** B-059: the INBOX's UIDVALIDITY and the next UID the IDLE watcher has not reported yet. */
export interface MailMark { validity: number; next: number }

export type McpTarget = HttpTarget | StdioTarget | MailTarget;

export interface McpConnectOptions {
  clientInfo: { name: string; version: string };
  /** Per request (default 60 s; tools/call may set its own). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Test seam: replaces global fetch for http targets. */
  fetch?: typeof fetch;
  /** Test seam / supervisor: starts a stdio server (default: runtime/system supervisor spawn). */
  spawn?: StdioSpawner;
}

export interface StdioChild {
  stdin: { write(chunk: string): boolean; end(): void };
  stdout: AsyncIterable<string | Uint8Array> | NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream | null;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}
export type StdioSpawner = (command: string, args: string[], opts: { env: Record<string, string>; cwd?: string }) => StdioChild;

export interface McpConnection {
  readonly info: McpServerInfo;
  /** tools/list with cursor paging (at most 500 tools). */
  listTools(signal?: AbortSignal): Promise<McpToolDef[]>;
  /** tools/call; an abort sends notifications/cancelled. Rejects with McpTransportError(sent: true) when the
   *  request may have reached the server but no answer came (the caller reports effect 'unknown'). */
  callTool(name: string, args: Record<string, unknown>, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<McpCallResult>;
  /** notifications/tools/list_changed (when the transport can receive it). Returns the unsubscribe. */
  onToolsChanged(listener: () => void): () => void;
  /** Ends the session (HTTP DELETE best-effort; stdio: close stdin, then terminate). */
  close(): Promise<void>;
}

/** The server wants authorization (HTTP 401, or 403 insufficient_scope). Parsed from WWW-Authenticate. */
export class McpAuthRequired extends Error {
  readonly status: 401 | 403;
  readonly resourceMetadata?: string;
  readonly scope?: string;
  readonly error?: string;
  constructor(input: { status: 401 | 403; resourceMetadata?: string; scope?: string; error?: string }) {
    super(input.status === 403 ? 'The app needs more access.' : 'The app needs a sign-in.');
    this.name = 'McpAuthRequired';
    this.status = input.status;
    this.resourceMetadata = input.resourceMetadata;
    this.scope = input.scope;
    this.error = input.error;
  }
}

/** Network/process failure. `sent`: the request may have reached the server. Message is user-safe. */
export class McpTransportError extends Error {
  readonly sent: boolean;
  constructor(message: string, sent: boolean) { super(message); this.name = 'McpTransportError'; this.sent = sent; }
}

/** A JSON-RPC error answer from the server (message clipped, user-safe). */
export class McpProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.name = 'McpProtocolError'; this.code = code; }
}

// ------------------------------------------------------------------ authorization (oauth/*)

export interface OAuthStart {
  /** The authorization URL the system browser opens. */
  authUrl: string;
  /** Resolves once tokens are stored; rejects (user-safe message) on denial, timeout (5 min) or cancel. */
  done: Promise<void>;
  cancel(): void;
}

/** Thrown when stored authorization is gone (invalid_grant, revoked, no refresh token): the app needs 'signin'. */
export class ReconnectNeeded extends Error {
  constructor(message = 'Sign in to the app again.') { super(message); this.name = 'ReconnectNeeded'; }
}

/** Thrown when the server's authorization server offers no way for this app to register (no DCR, no CIMD). */
export class OAuthUnsupported extends Error {
  constructor(message = 'This app does not allow a sign-in from here – use a token instead.') { super(message); this.name = 'OAuthUnsupported'; }
}

export interface AppOAuth {
  /** Discovery (RFC 9728 → RFC 8414/OIDC), client registration (stored per issuer), PKCE, loopback listener;
   *  does not open the browser itself. `challenge` is the 401/403 that started it. */
  begin(input: { appId: string; resourceUrl: string; challenge: McpAuthRequired; appName: string }): Promise<OAuthStart>;
  /** Authorization header for the next request; refreshes (serialized, rotation stored) when needed.
   *  Throws ReconnectNeeded. Returns {} when the app has no OAuth grant – or, given the app's address, when the grant
   *  belongs to another address (an app of the same id re-added elsewhere never gets the old token). */
  authHeaders(appId: string, resourceUrl?: string): Promise<Record<string, string>>;
  /** Whether a grant (refresh token or unexpired access token) is stored. */
  hasGrant(appId: string): boolean;
  /** Best-effort revocation, then deletes the grant and its vault entries. */
  forget(appId: string): Promise<void>;
  /** Ends every open sign-in (shutdown). */
  close(): void;
}

// ------------------------------------------------------------------ connectors (connectors.ts)

/** The part of the KV store the apps code uses: one namespace ('apps'), wired by runtime/apps/index.ts. */
export interface AppKv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  /** Keys starting with `prefix` (all keys without one). */
  keys(prefix?: string): string[];
}

/** One connector as its file names it (values may hold secret://<id> handles, resolved when it connects). */
export interface Connector {
  /** The tool-name id (APP_ID_PATTERN), from its key. */
  id: string;
  /** Its key in the file. */
  name: string;
  transport: AppTransport;
  /** http: the MCP endpoint; headers are sent with every request (an Authorization header replaces the sign-in). */
  url?: string;
  headers?: Record<string, string>;
  /** stdio: the program, its arguments, folder and extra environment. */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** mail: the mailbox; servers are looked up from the address when not given; `agent` (id or name) is woken by new mail. */
  mail?: { address: string; user?: string; password: string; imap?: MailServer; smtp?: MailServer; agent?: string };
  enabled: boolean;
  /** Changes whenever the entry's content does (a changed entry connects again; its "agents" list is left out). */
  fingerprint: string;
  /** AF-005: the agents (ids or names) that may use it – missing: every agent (agent-access.ts). */
  agents?: string[];
}

/** What tools.ts needs from the service to turn a connector's MCP tools into Workforce tools. */
export interface AppToolHost {
  /** The connector and its live state – read at call time. */
  state(appId: string): { connector: Connector; status: ConnectedApp['status']; error?: string } | undefined;
  /** Runs the MCP call on a (lazily opened) connection. Rejects with Mcp* errors / ReconnectNeeded. */
  call(appId: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
}

/** The connectors service (RuntimeServices.apps, contracts/apps.ts). */
export interface AppsService {
  /** Applies the files (once migrating old Settings › Apps records), registers cached tools and starts watching. */
  start(): void;
  /** Ends sign-ins and the watcher, closes connections and stdio servers. */
  stop(): Promise<void>;
  list(): ConnectedApp[];
  /** Connects again; an MCP server that needs a sign-in opens it in the system browser. */
  reconnect(id: string): Promise<ConnectedApp>;
  /** Ids of the connectors whose tools this agent gets right now (for the environment line; AF-005: their "agents" lists). */
  usableBy(agentId: string): string[];
}
