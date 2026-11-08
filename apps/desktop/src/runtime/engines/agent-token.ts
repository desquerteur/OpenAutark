// AF-001: an agent's own identity for the app's wf client. Agents reach the running app through `wf` (wf-shim.ts), which
// authenticates with the owner token from runtime.json – so before this, a line an agent wrote with `wf send` (an engine
// without the MCP chat tool, a shell script) stood in the chat as the person's, and in the agent's 1:1 it even woke the
// agent again. Every shell and engine process of an agent now gets AUTARK_AGENT_TOKEN (shared/api/protocol.ts
// AGENT_TOKEN_ENV): `wfa1.<agent id, base64url>.<HMAC-SHA256 of it>` under a key that lives only in this runtime process –
// Claude Code per turn, Codex per thread (its shells keep the thread's env, so the token names the agent, not a run),
// shell.exec and secrets.run per call (tools/builtin/command.ts). wf sends it beside the owner token (Hello `agent`); the
// socket keeps owner access and carries the agent's id (ClientScope owner `agentId`, http/ws.ts), and messages.send then
// posts as that agent (rpc/handlers/agent-send.ts). A token from another process (an earlier start, another company) or of
// an archived agent is refused at the handshake (close 4406), so nothing an agent writes falls back to the person's name.
// ACP agents share one process per account (acp/engine.ts) and get no token: their wf still writes as the owner.
// Owns: the key, issuing and checking tokens, the env entry. Never: writes the key or a token to a file or a log.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AGENT_TOKEN_ENV } from '../../shared/api/protocol.ts';
import type { RuntimeServices } from '../contracts.ts';

const VERSION = 'wfa1';
const MAX_TOKEN = 512;
const MAX_ID = 200;
/** This process's key: tokens die with the runtime (its engine processes do too). */
const KEY = randomBytes(32);

const mac = (agentId: string): Buffer => createHmac('sha256', KEY).update(`${VERSION}\u0000${agentId}`).digest();

/** The identity token of `agentId` (stable for this runtime process). */
export function agentToken(agentId: string): string {
  return `${VERSION}.${Buffer.from(agentId, 'utf8').toString('base64url')}.${mac(agentId).toString('base64url')}`;
}

/** The agent id a token names when this process issued it; undefined for a forged, foreign or malformed token. */
export function agentOfToken(token: string): string | undefined {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) return undefined;
  const [version, id, sig, ...rest] = token.split('.');
  if (version !== VERSION || !id || !sig || rest.length) return undefined;
  const agentId = Buffer.from(id, 'base64url').toString('utf8');
  const given = Buffer.from(sig, 'base64url');
  const expected = mac(agentId);
  if (!agentId || agentId.length > MAX_ID || given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return agentId;
}

/** The token's agent when it is an active agent of this runtime (Hello `agent`, http/server.ts); undefined refuses it. */
export function actingAgent(services: Pick<RuntimeServices, 'org'>, token: string): string | undefined {
  const agentId = agentOfToken(token);
  if (!agentId) return undefined;
  try {
    const agent = services.org.get(agentId);
    return agent && !agent.archivedAt ? agent.id : undefined;
  } catch {
    return undefined;
  }
}

/** `{ AUTARK_AGENT_TOKEN }` for the processes `agentId` runs (engines: the turn's agent; an empty id gets nothing). */
export function agentIdentityEnv(agentId: string | undefined): Record<string, string> {
  return agentId && agentId.length <= MAX_ID ? { [AGENT_TOKEN_ENV]: agentToken(agentId) } : {};
}

/** The same for a tool call: only for an active agent of this runtime – never for a stand-in of another company or PC. */
export function agentTokenEnv(services: Pick<RuntimeServices, 'org'> | undefined, agentId: string): Record<string, string> {
  try {
    const agent = services?.org.get(agentId);
    return agent && !agent.archivedAt ? agentIdentityEnv(agent.id) : {};
  } catch {
    return {};
  }
}
