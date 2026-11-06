// Errors and exit codes of the wf terminal client (C7, bundled to app/wf.mjs).
//   0 ok · 1 failed (timeout, conflict, a failed agent reply …) · 2 bad request / usage
//   3 forbidden (also a refused owner token) · 4 not found · 5 runtime unreachable · 130 interrupted
// Owns: the CliError kinds, their exit codes, the meaning of runtime error frames and close codes
// for this client. Never: prints anything or carries the owner token in a message.

import type { ErrorCode, WorkforceErrorData } from '../../shared/errors.ts';

export type CliErrorKind = ErrorCode | 'unreachable' | 'failed' | 'interrupted';

export class CliError extends Error {
  readonly kind: CliErrorKind;
  readonly details?: Record<string, unknown>;

  constructor(kind: CliErrorKind, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CliError';
    this.kind = kind;
    this.details = details;
  }
}

export const EXIT = { ok: 0, failed: 1, badRequest: 2, forbidden: 3, notFound: 4, unreachable: 5, interrupted: 130 } as const;

export function exitCodeOf(kind: CliErrorKind): number {
  switch (kind) {
    case 'bad_request': return EXIT.badRequest;
    case 'forbidden': return EXIT.forbidden;
    case 'not_found': return EXIT.notFound;
    case 'unreachable': return EXIT.unreachable;
    case 'interrupted': return EXIT.interrupted;
    default: return EXIT.failed;
  }
}

/**
 * A runtime error frame as a CliError. The RPC server answers an unknown method with not_found
 * "Unknown method." and `details.method` (rpc/server.ts) – for the caller that is a bad request
 * (exit 2), unlike a missing chat or task (exit 4).
 */
export function fromRpcError(data: WorkforceErrorData | undefined, method: string): CliError {
  const code = data?.code ?? 'internal';
  const message = typeof data?.message === 'string' && data.message ? data.message : 'The runtime reported an error.';
  if (code === 'not_found' && data?.details?.method === method && message === 'Unknown method.') {
    return new CliError('bad_request', `Unknown method: ${method}.`, { method });
  }
  return new CliError(code, message, data?.details);
}

/** What a closed `/ws` socket means (runtime/http/ws.ts CLOSE codes). */
export function closeError(code: number): CliError {
  switch (code) {
    case 4401:
    case 4403:
      return new CliError('forbidden', 'The runtime did not accept the owner token in runtime.json. Restart the app, then try again.');
    case 4400:
      return new CliError('bad_request', 'The runtime does not speak this client\'s protocol version. Use the wf client of the same app version.');
    case 4408:
      return new CliError('unreachable', 'The runtime closed the connection before it was ready.');
    case 1013:
      return new CliError('unreachable', 'The runtime has too many open connections right now.');
    case 1001:
      return new CliError('unreachable', 'The runtime stopped.');
    case 4429:
      return new CliError('unreachable', 'The runtime dropped this connection because output was not read fast enough.');
    default:
      return new CliError('unreachable', 'The connection to the runtime was lost.');
  }
}

/** Anything thrown as a CliError (unexpected errors keep only their message). */
export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const message = error instanceof Error && error.message ? error.message : 'Something went wrong.';
  return new CliError('failed', message);
}
