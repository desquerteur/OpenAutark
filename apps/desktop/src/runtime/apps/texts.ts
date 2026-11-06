// The words the connectors service gives the AI and the person: what a connector needs when it wants a
// sign-in or a key, a failure without its secrets, and a connector's address as the person recognises it.
// Owns: clip, hasAuthorization, signInText, errorText, addressOf. Never: a token, header, env value,
// response body or address from an error (only the host of an http server).

import { WorkforceError } from '../../shared/errors.ts';
import { McpProtocolError, McpTransportError, type Connector } from './types.ts';

export const clip = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 200);
export const hasAuthorization = (connector: Connector) => Object.keys(connector.headers ?? {}).some((name) => name.toLowerCase() === 'authorization');

/** What the AI reads when a connector needs a sign-in or a key. */
export function signInText(connector: Connector): string {
  if (connector.transport === 'mail') return 'The mailbox refused the login – check address, "user" and "password" in mail.json (usually an app password).';
  if (connector.transport === 'stdio') return 'The server wants a key – put it into its "env" in mcp.json (as secret://<id>).';
  if (hasAuthorization(connector)) return 'The server refused the key in its "headers" – check the secret it names.';
  return `It needs a sign-in: \`wf call apps.reconnect '{"id":"${connector.id}"}'\` (PowerShell: \`'{"id":"${connector.id}"}' | wf call apps.reconnect -\`) opens the page for the person (or put a key into "headers").`;
}

/** A failure as the AI reads it (no response body, no address, no value). */
export function errorText(error: unknown, name: string): string {
  if (error instanceof McpTransportError) return clip(error.message) || `Could not reach ${name}.`;
  if (error instanceof McpProtocolError) return `${name} answered with an error (code ${error.code}).`;
  if (error instanceof WorkforceError) return clip(error.message);
  return `Could not connect to ${name}.`;
}

/** What the person recognises: an http server's host, a command's name, a mailbox's address. */
export function addressOf(connector: Connector): string {
  if (connector.transport === 'mail') return connector.mail?.address ?? '';
  if (connector.transport === 'http') { try { return new URL(connector.url ?? '').host; } catch { return ''; } }
  return (connector.command ?? '').trim().split(/[\\/]/).pop()?.replace(/\.(exe|cmd|bat|ps1|com)$/i, '') ?? '';
}
