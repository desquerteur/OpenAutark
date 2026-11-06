// Live reasoning in the run journal (D5): every reasoning block of an engine attempt becomes one
// 'reasoning' run item ({summary, live}) as soon as its first words arrive – so it sits between the
// tool calls it came before and after – grows by throttled updates (at most every 400 ms or 300 new
// characters, plus one trailing update) and is closed (live: false) at its end, at the next tool
// call, text or work update, or when the attempt ends. An engine's authoritative end text (Codex's
// completed reasoning item) replaces what the deltas built. Text is secret-redacted and capped per
// block; each new headline becomes the live status ("Planning the PC search", not "thinking").
// Owns: block state, throttle, per-block cap and the headline status. Never: invents reasoning,
// journals a block without words, or lets a journal failure reach the turn.

import { reasoningHeadline } from '../../shared/text/step-label.ts';

/** Characters kept per reasoning block (the journal caps one string at 4000 too). */
export const REASONING_BLOCK_CHARS = 4000;
/** Characters of all blocks the attempt result carries (AttemptResult.reasoning). */
const ATTEMPT_CHARS = 4000;
const FLUSH_MS = 400;
const FLUSH_CHARS = 300;
const KEEP_CLOSED = 50;

export interface ReasoningSink {
  /** Journals a new live block; returns its item id (undefined: nothing journaled, updates are skipped). */
  open(summary: string): string | undefined;
  update(itemId: string, data: { summary: string; live: boolean }): void;
  redact(text: string): string;
  status(note: string): void;
  now(): number;
  /** One trailing flush (default: an unref'd setTimeout); returns its cancel. */
  later?(run: () => void, ms: number): () => void;
  warn?(message: string, error: unknown): void;
}

interface Block {
  key?: string; // the engine's block id
  itemId?: string;
  opened: boolean;
  text: string;
  flushed: number; // text length at the last write
  flushedAt: number;
  headline: string;
  cancel?: () => void;
}

const defaultLater = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export class ReasoningLog {
  private readonly sink: ReasoningSink;
  private current: Block | undefined;
  private readonly blocks: Block[] = [];
  private readonly closed = new Map<string, Block>();

  constructor(sink: ReasoningSink) {
    this.sink = sink;
  }

  /** All blocks' text of this attempt, capped (AttemptResult.reasoning). */
  get text(): string {
    return this.blocks.map((block) => block.text.trim()).filter(Boolean).join('\n\n').slice(0, ATTEMPT_CHARS);
  }

  delta(text: string, id?: string): void {
    if (!text) return;
    let block = this.current;
    if (block && id !== undefined && block.key !== undefined && block.key !== id) { this.close(); block = undefined; }
    if (!block) {
      if (!text.trim()) return; // a section break before any words opens nothing
      block = this.start(id);
    }
    if (block.key === undefined && id !== undefined) block.key = id;
    const room = REASONING_BLOCK_CHARS - block.text.length;
    if (room <= 0) return;
    block.text += text.slice(0, room);
    this.write(block);
  }

  /** The engine ended a block; `text` (non-empty) is its authoritative full text. */
  end(id?: string, text?: string): void {
    const authoritative = text?.trim() ? text.slice(0, REASONING_BLOCK_CHARS) : undefined;
    const current = this.current;
    if (current && (id === undefined || current.key === undefined || current.key === id)) {
      if (authoritative) current.text = authoritative;
      this.close();
      return;
    }
    const earlier = id !== undefined ? this.closed.get(id) : undefined;
    if (earlier) {
      if (authoritative && authoritative !== earlier.text) { earlier.text = authoritative; this.flush(earlier, false); }
      return;
    }
    if (!authoritative) return;
    // Only the end arrived (no deltas): one closed block with the engine's text.
    if (current) this.close();
    const block = this.start(id);
    block.text = authoritative;
    this.close();
  }

  /** Closes the open block (the next tool call, text or update, or the attempt's end). */
  close(): void {
    const block = this.current;
    if (!block) return;
    this.current = undefined;
    block.cancel?.();
    block.cancel = undefined;
    if (block.text.trim()) this.flush(block, false);
    if (block.key !== undefined) {
      this.closed.delete(block.key);
      this.closed.set(block.key, block);
      if (this.closed.size > KEEP_CLOSED) this.closed.delete(this.closed.keys().next().value!);
    }
  }

  private start(id: string | undefined): Block {
    const block: Block = { ...(id !== undefined ? { key: id } : {}), opened: false, text: '', flushed: 0, flushedAt: 0, headline: '' };
    this.current = block;
    this.blocks.push(block);
    if (this.blocks.length > 200) this.blocks.shift();
    return block;
  }

  /** Writes now when the block is new or the throttle allows, else once a little later. */
  private write(block: Block): void {
    const now = this.sink.now();
    if (!block.opened || now - block.flushedAt >= FLUSH_MS || block.text.length - block.flushed >= FLUSH_CHARS) {
      block.cancel?.();
      block.cancel = undefined;
      this.flush(block, true);
      return;
    }
    if (block.cancel) return;
    block.cancel = (this.sink.later ?? defaultLater)(() => {
      block.cancel = undefined;
      if (this.current === block) this.flush(block, true);
    }, FLUSH_MS);
  }

  private flush(block: Block, live: boolean): void {
    const summary = this.safe(() => this.sink.redact(block.text), block.text).trim();
    if (!summary) return;
    block.flushed = block.text.length;
    block.flushedAt = this.sink.now();
    if (!block.opened) {
      block.opened = true;
      block.itemId = this.safe(() => this.sink.open(summary), undefined);
      if (!live && block.itemId) this.safe(() => this.sink.update(block.itemId!, { summary, live: false }), undefined);
    } else if (block.itemId) {
      this.safe(() => this.sink.update(block.itemId!, { summary, live }), undefined);
    }
    const headline = reasoningHeadline(summary);
    if (headline && headline !== block.headline) {
      block.headline = headline;
      this.safe(() => this.sink.status(headline), undefined);
    }
  }

  private safe<T>(run: () => T, fallback: T): T {
    try { return run(); } catch (error) { this.sink.warn?.('reasoning journal write failed', error); return fallback; }
  }
}
