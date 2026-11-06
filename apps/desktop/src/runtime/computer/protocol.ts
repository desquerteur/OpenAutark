// Wire protocol of the persistent Windows helper (resources/computer/windows-helper.ps1):
// one JSON object per line on stdin (requests) and stdout (ready line + responses).
// Owns: message shapes, ASCII-safe encoding (non-ASCII escaped as \uXXXX so the console code
// page can never corrupt text that is typed) and a tolerant line decoder.
// Never: spawns processes or interprets results (helper.ts / service.ts do).

/**
 * Bump together with the helper scripts when the message shapes change (2: 'release'; 3, B-044:
 * config `appPids` instead of protectPids; a click, drag, keys, text or element action that would
 * reach a window of the Workforce app answers APP_WINDOW with what it would hit (`error.app`) until
 * the request carries `app` – the window the runtime cleared, true on Linux; windows list `app`;
 * 4, B-055: 'path' replays a planned pointer path with precise timing and ends in a click, a drag
 * or wheel steps (computer/motion.ts; it replaces 'drag'), an element click may carry `path`, and
 * the person moving the mouse mid-path answers HUMAN_ACTIVE; 'cursor' also says the idle times).
 */
export const HELPER_PROTOCOL = 4;

/** The error code of input that reaches a Workforce window without the runtime's clearance. */
export const APP_WINDOW = 'app_window';
/** The error code of a path the person interrupted by moving the mouse (or pressing a button) before anything was pressed. */
export const HUMAN_ACTIVE = 'human_active';

/** What that input would hit: the app's top-level window, the pressed point, the element's rectangle, or the keyboard. */
export interface AppWindowHit { window?: number; point?: { x: number; y: number }; rect?: [number, number, number, number]; keyboard?: boolean }

export type HelperOp =
  | 'ping' | 'config' | 'presence' | 'screens' | 'screenshot' | 'windows' | 'focus_window'
  | 'tree' | 'find' | 'act' | 'click' | 'move' | 'path' | 'scroll' | 'type' | 'key' | 'cursor' | 'ocr'
  // Lets go of mouse buttons and Ctrl/Shift/Alt/Win keys Windows reports held (after a Stop); never presses anything.
  | 'release';

export interface HelperRequest {
  id: number;
  op: HelperOp;
  args: Record<string, unknown>;
}

export interface HelperReady {
  ready: true;
  protocol: number;
  pid: number;
  dpiAware: boolean;
}

export interface HelperErrorData {
  code: string;
  message: string;
  /** With APP_WINDOW only. */
  app?: AppWindowHit;
}

export type HelperResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: HelperErrorData };

export type HelperMessage =
  | { kind: 'ready'; ready: HelperReady }
  | { kind: 'response'; response: HelperResponse }
  | { kind: 'noise'; line: string };

/** JSON with every character outside printable ASCII escaped (valid JSON, pure ASCII). */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** One request line including the trailing newline. */
export function encodeRequest(request: HelperRequest): string {
  return `${asciiJson({ id: request.id, op: request.op, args: request.args })}\n`;
}

/** Classifies one decoded stdout line. Anything that is not a protocol message is noise. */
export function classify(line: string): HelperMessage {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { kind: 'noise', line }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'noise', line };
  const record = value as Record<string, unknown>;
  if (record.ready === true) {
    return {
      kind: 'ready',
      ready: {
        ready: true,
        protocol: typeof record.protocol === 'number' ? record.protocol : 0,
        pid: typeof record.pid === 'number' ? record.pid : 0,
        dpiAware: record.dpiAware === true,
      },
    };
  }
  if (typeof record.id !== 'number' || !Number.isInteger(record.id)) return { kind: 'noise', line };
  if (record.ok === true) return { kind: 'response', response: { id: record.id, ok: true, result: record.result } };
  const error = record.error as (Partial<HelperErrorData> & { app?: unknown }) | undefined;
  const code = typeof error?.code === 'string' ? error.code : 'internal';
  const app = code === APP_WINDOW ? appHit(error?.app) : undefined;
  return {
    kind: 'response',
    response: {
      id: record.id,
      ok: false,
      error: {
        code,
        message: typeof error?.message === 'string' && error.message ? error.message : 'The computer-use helper failed.',
        ...(app ? { app } : {}),
      },
    },
  };
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The helper's `error.app`, keeping only well-formed parts (an empty hit still means "a Workforce window"). */
export function appHit(value: unknown): AppWindowHit {
  const item = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const hit: AppWindowHit = {};
  if (finite(item.window) && item.window !== 0) hit.window = item.window;
  const point = item.point as { x?: unknown; y?: unknown } | undefined;
  if (point && finite(point.x) && finite(point.y)) hit.point = { x: point.x, y: point.y };
  if (Array.isArray(item.rect) && item.rect.length === 4 && item.rect.every(finite)) hit.rect = item.rect as [number, number, number, number];
  if (item.keyboard === true) hit.keyboard = true;
  return hit;
}

/**
 * Splits a byte/text stream into lines (\n or \r\n) and classifies them. Keeps at most
 * `maxLine` characters of an unterminated line so a runaway stream cannot grow memory.
 */
export class LineDecoder {
  private buffer = '';
  private readonly maxLine: number;
  private readonly decoder = new TextDecoder('utf-8');

  constructor(maxLine = 32 * 1024 * 1024) {
    this.maxLine = maxLine;
  }

  push(chunk: Uint8Array | string): HelperMessage[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    const out: HelperMessage[] = [];
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (line.trim()) out.push(classify(line));
    }
    if (this.buffer.length > this.maxLine) this.buffer = '';
    return out;
  }
}

/** Maps a helper error code onto the shared error codes (unknown codes become 'internal'; APP_WINDOW is a refusal, HUMAN_ACTIVE a conflict). */
export function errorCodeOf(code: string): 'bad_request' | 'not_found' | 'conflict' | 'forbidden' | 'unavailable' | 'timeout' | 'internal' {
  if (code === APP_WINDOW) return 'forbidden';
  if (code === HUMAN_ACTIVE) return 'conflict';
  switch (code) {
    case 'bad_request':
    case 'not_found':
    case 'conflict':
    case 'forbidden':
    case 'unavailable':
    case 'timeout':
      return code;
    default:
      return 'internal';
  }
}
