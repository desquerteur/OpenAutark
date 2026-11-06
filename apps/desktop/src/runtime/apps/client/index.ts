// The MCP client's front door. connectMcp() opens a connection to an app's MCP server – Streamable
// HTTP (http.ts) or a local program over stdio (stdio.ts, started through spawn.ts) – runs the handshake
// (session.ts) and returns the McpConnection – a mailbox (mail/index.ts connectMail) is an in-process connection
// of the same shape – the service (connections.ts) keeps: listTools, callTool,
// onToolsChanged, close. A failed handshake closes what it opened (HTTP DELETE, stdio process ended).
// Owns: choosing the wire and that cleanup. Never: stores, logs or returns a header, env value or session id.

import { connectMail } from '../mail/index.ts';
import type { McpConnectOptions, McpConnection, McpTarget } from '../types.ts';
import { HttpWire } from './http.ts';
import { McpSession } from './session.ts';
import { StdioWire } from './stdio.ts';

export { checkHttpUrl } from './http.ts';
export { DEFAULT_TIMEOUT_MS, MAX_TOOLS, McpTimeout, McpVersionUnsupported } from './session.ts';
export { childEnv, defaultSpawner, resolveCommand, supervisorSpawner } from './spawn.ts';

/** Connects and completes the handshake; rejects with McpAuthRequired, McpTransportError or McpProtocolError. */
export async function connectMcp(target: McpTarget, opts: McpConnectOptions): Promise<McpConnection> {
  if (target.kind === 'mail') return connectMail(target, opts);
  const session = new McpSession({ clientInfo: opts.clientInfo, timeoutMs: opts.timeoutMs, transport: target.kind, lifetime: opts.signal });
  if (target.kind === 'http') {
    const fetchFn: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
    session.attach(new HttpWire(target, { fetch: fetchFn, incoming: session.incoming }));
  } else {
    session.attach(await StdioWire.start(target, { spawn: opts.spawn, incoming: session.incoming }));
  }
  try {
    await session.open();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
  return session;
}
