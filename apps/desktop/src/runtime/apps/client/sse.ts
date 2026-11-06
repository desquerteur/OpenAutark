// B-052 track A: a small, robust text/event-stream parser (WHATWG "server-sent events" interpretation) for the
// Streamable HTTP answers of MCP servers: lines end in CRLF, LF or CR (also split across chunks), `data:` lines join
// with "\n", `event:` / `id:` / `retry:` fields, `:` comments, one leading space after the colon is dropped, a
// leading BOM is skipped, an event is dispatched on a blank line (and at the end of the stream).
// Owns: the parsing and its size cap. Never: interprets the data (http.ts reads JSON-RPC from it) or logs it.

export interface SseEvent {
  /** The event type ('message' when the stream names none). */
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/** One event's data may not grow beyond this (a bigger one is dropped and counted). */
export const SSE_MAX_EVENT = 16 * 1024 * 1024;

export class SseParser {
  private buffer = '';
  private started = false;
  private pendingCr = false;
  private data: string[] = [];
  private dataSize = 0;
  private type = '';
  private lastId: string | undefined;
  private retryMs: number | undefined;
  private overflow = false;
  private readonly maxEvent: number;
  /** Events dropped because they were larger than the cap. */
  dropped = 0;

  constructor(maxEvent = SSE_MAX_EVENT) { this.maxEvent = maxEvent; }

  /** The last event id seen – also of an event without data (a priming event), for resuming with Last-Event-ID. */
  get lastEventId(): string | undefined { return this.lastId; }

  /** The server's last `retry` (ms), if it sent one. */
  get retry(): number | undefined { return this.retryMs; }

  /** Feeds decoded text; returns the events completed by it. */
  push(text: string): SseEvent[] {
    const out: SseEvent[] = [];
    let chunk = text;
    if (!this.started && chunk) {
      this.started = true;
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
    }
    if (this.pendingCr && chunk.startsWith('\n')) chunk = chunk.slice(1); // the LF of a CRLF split across chunks
    this.pendingCr = false;
    const scanned = this.buffer.length; // the kept rest has no line end: scan only the new text
    this.buffer += chunk;
    let start = 0;
    for (let index = scanned; index < this.buffer.length; index++) {
      const char = this.buffer.charCodeAt(index);
      if (char !== 10 && char !== 13) continue;
      this.line(this.buffer.slice(start, index), out);
      if (char === 13) {
        if (index + 1 < this.buffer.length) { if (this.buffer.charCodeAt(index + 1) === 10) index++; }
        else this.pendingCr = true;
      }
      start = index + 1;
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length > this.maxEvent) { this.buffer = ''; this.overflow = true; } // a line without end
    return out;
  }

  /** The stream ended: a last event without its blank line still counts. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buffer) { this.line(this.buffer, out); this.buffer = ''; }
    this.dispatch(out);
    return out;
  }

  private line(line: string, out: SseEvent[]): void {
    if (line === '') { this.dispatch(out); return; }
    if (line.startsWith(':')) return; // comment (keep-alive)
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'data':
        this.dataSize += value.length + 1;
        if (this.dataSize > this.maxEvent) this.overflow = true;
        else this.data.push(value);
        break;
      case 'event': this.type = value; break;
      case 'id': if (!value.includes('\u0000')) this.lastId = value; break;
      case 'retry': if (/^\d+$/.test(value)) this.retryMs = Number(value); break;
      default: break; // unknown fields are ignored
    }
  }

  private dispatch(out: SseEvent[]): void {
    const type = this.type || 'message';
    const hadData = this.data.length > 0 || this.overflow;
    if (this.overflow) this.dropped++;
    else if (hadData) {
      const event: SseEvent = { event: type, data: this.data.join('\n') };
      if (this.lastId !== undefined) event.id = this.lastId;
      if (this.retryMs !== undefined) event.retry = this.retryMs;
      out.push(event);
    }
    this.data = [];
    this.dataSize = 0;
    this.type = '';
    this.overflow = false;
  }
}
