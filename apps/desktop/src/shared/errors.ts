// Error codes that cross process boundaries (runtime → UI, runtime → peers, tools → agents).
// Owns: the stable code list and the plain-data error shape.
// Never: carries secrets, raw provider bodies or stack traces to the UI.

export type ErrorCode =
  | 'bad_request' // invalid params
  | 'not_found'
  | 'conflict' // state changed / already exists / busy
  | 'forbidden' // policy or trust boundary
  | 'budget_exceeded'
  | 'rate_limited' // provider quota; retry later or rotate
  | 'unavailable' // engine/device/provider not reachable or not logged in
  | 'timeout'
  | 'cancelled'
  | 'unknown_effect' // an external effect may or may not have happened
  | 'internal';

export interface WorkforceErrorData {
  code: ErrorCode;
  message: string; // short, user-safe English sentence
  retryAfterMs?: number;
  details?: Record<string, unknown>; // safe, structured extra info (ids, limits)
}

export class WorkforceError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, extra: { retryAfterMs?: number; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.name = 'WorkforceError';
    this.code = code;
    this.retryAfterMs = extra.retryAfterMs;
    this.details = extra.details;
  }

  toData(): WorkforceErrorData {
    return { code: this.code, message: this.message, retryAfterMs: this.retryAfterMs, details: this.details };
  }
}

/** Converts anything thrown into safe error data (unknown errors become `internal`). */
export function toErrorData(error: unknown): WorkforceErrorData {
  if (error instanceof WorkforceError) return error.toData();
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const value = error as { code: unknown; message: unknown };
    if (typeof value.code === 'string' && typeof value.message === 'string' && isErrorCode(value.code)) {
      return { code: value.code, message: value.message };
    }
  }
  return { code: 'internal', message: 'Something went wrong. It was logged.' };
}

const CODES: ReadonlySet<string> = new Set([
  'bad_request', 'not_found', 'conflict', 'forbidden', 'budget_exceeded',
  'rate_limited', 'unavailable', 'timeout', 'cancelled', 'unknown_effect', 'internal',
]);

export function isErrorCode(value: string): value is ErrorCode {
  return CODES.has(value);
}
