// ContextLedger (B-048 E1): the single source of what an agent's working context in a chat is – ids, order,
// token estimates, titles, marks (keep / condensed / hidden), pins, what the native session holds (applied)
// and the way back to every original. The subconscious (subconscious/context-tools.ts) marks, the native rebuild
// (agents/rebuild.ts) reads view(), the agent restores through context.restore (tools/builtin/context.ts).
// Owns: the contract's methods over store.ts, capture (capture.ts), originals (originals.ts), the view
// (view.ts) and retention (retention.ts: after every mark, a bounded start-up pass, a removed chat), the person's
// Forget (forget.ts: copies cleared, originals that mention it pruned – rpc knowledge.forget calls it); the
// person's edit retitles a message's rows (and lifts a condensed/hidden mark set before the edit: the new text
// shows again), a deleted message's rows keep none of its words and leave the view; a restore pins from the
// running turn even before that turn captured anything – for PIN_TURNS turns, or for good with `keep` (B-050 K5:
// pinned_until = KEEP_PIN, at most KEEP_TOKENS per agent and chat – beyond that a keep pins for PIN_TURNS turns;
// `keep: false` ends a pin for good, so the subconscious may condense the item again); a plain restore never shortens a
// pin that holds longer. B-049 F9: a nested item (a call inside a code-mode script, store.ts) shows as `nested` and is
// left out of what a rebuild would change (needsRebuild) and never marked by the subconscious: the native session never held it.
// Never: posts, routes or rebuilds sessions itself; treats ledger text as instructions; lets a capture
// failure reach the journal or the turn.

import type { ContextLedger, LedgerRun, RebuildNeed, RuntimeServices } from '../../contracts.ts';
import '../../contracts/ledger.ts';
import {
  estimateTokens, ledgerTitle, liveTokens, PIN_TURNS, type LedgerItem, type LedgerKind, type LedgerMark, type LedgerView, type LedgerViewItem, type NewLedgerItem,
} from '../../../shared/model/context-ledger.ts';
import type { Message } from '../../../shared/model/chat.ts';
import { renderContext } from '../delta.ts';
import { redactText, renderMessages } from '../render.ts';
import { LedgerCapture } from './capture.ts';
import { callArgsOf, originalOf } from './originals.ts';
import { forgetChat, prune, pruneAll, type RetentionDeps } from './retention.ts';
import { forgetInLedger, type LedgerForget } from './forget.ts';
import { LedgerStore, toItem, type LedgerRow } from './store.ts';
import { goneWithScript, viewItem, type ViewDeps } from './view.ts';

/** Condensed texts and mark reasons are capped (a condensed text is keywords, never a second original). */
const CONDENSED_CHARS = 4000;
const REASON_CHARS = 300;
/** original(): the whole original up to this many characters (context.restore caps per call itself). */
const ORIGINAL_CHARS = 1_000_000;
/** The restore stamp costs about this much (shared/model/context-ledger.ts compactStamp). */
const STAMP_TOKENS = 20;
/** B-050 K5: a pin for good (a turn count no chat reaches; context-tools.ts reads it as pinned too). */
export const KEEP_PIN = Number.MAX_SAFE_INTEGER;
/** B-050 K5: at most this many tokens per agent and chat are kept for good; a keep beyond it pins for PIN_TURNS turns. */
export const KEEP_TOKENS = 8_000;

export interface LedgerOptions {
  services: () => RuntimeServices;
  /** Tests: a smaller retention budget (bytes). */
  budget?: number;
}

export class ContextLedgerService implements ContextLedger {
  private readonly options: LedgerOptions;
  private storeCache: LedgerStore | undefined;
  private captureCache: LedgerCapture | undefined;

  constructor(options: LedgerOptions) {
    this.options = options;
  }

  private get s(): RuntimeServices {
    return this.options.services();
  }

  private get store(): LedgerStore {
    return (this.storeCache ??= new LedgerStore(this.s.db));
  }

  private get capturing(): LedgerCapture {
    return (this.captureCache ??= new LedgerCapture({
      db: this.s.db, store: this.store, chats: this.s.chats, files: this.s.files, log: this.s.log,
      record: (agentId, conversationId, item) => this.record(agentId, conversationId, item),
      mark: (agentId, conversationId, marks) => this.mark(agentId, conversationId, marks),
      renderMessage: (message, agentId) => this.renderMessage(message, agentId),
    }));
  }

  private renderMessage(message: Message, agentId: string): string {
    const lines = renderMessages(renderContext(this.s, agentId), [message], { images: false }).lines;
    return redactText(this.s, lines.join('\n'));
  }

  private redact = (text: string): string => redactText(this.s, text);

  private viewDeps(): ViewDeps {
    return { db: this.s.db, files: this.s.files, chats: this.s.chats, redact: this.redact, renderMessage: (message, agentId) => this.renderMessage(message, agentId) };
  }

  private retention(): RetentionDeps {
    return { db: this.s.db, store: this.store, files: this.s.files, log: this.s.log, now: () => this.s.clock.now(), budget: this.options.budget };
  }

  record(agentId: string, conversationId: string, item: NewLedgerItem): LedgerItem {
    const tokens = Math.max(0, Math.round(item.tokens ?? estimateTokens(item.text)));
    const title = ledgerTitle(item.title ?? item.text, item.kind);
    const row = this.s.db.tx(() => {
      const known = item.ref ? this.store.byRef(agentId, conversationId, item.ref)
        : item.kind === 'message' && item.seq ? this.store.row(agentId, conversationId, `m${Math.floor(item.seq)}`) : undefined;
      if (known) return this.store.refresh(known, { title, tokens, ...(item.bytes !== undefined ? { bytes: Math.max(0, Math.round(item.bytes)) } : {}) });
      if (item.kind === 'message' && item.seq) {
        const taken = this.store.row(agentId, conversationId, `m${Math.floor(item.seq)}`);
        if (taken) return taken;
      }
      return this.store.insert({
        agent_id: agentId, conversation_id: conversationId, kind: item.kind, ...(item.seq !== undefined ? { seq: item.seq } : {}),
        run_id: item.runId ?? null, created_at: item.createdAt ?? this.s.clock.now(), tokens, title,
        origin_engine: item.origin?.engine ?? null, origin_model: item.origin?.model ?? null, ref: item.ref ?? null, bytes: Math.max(0, Math.round(item.bytes ?? 0)),
      });
    });
    return this.item(row, this.turns(agentId, conversationId));
  }

  /** A row as callers see it; title and condensed text redacted on the way out (a secret saved after the capture). */
  private item(row: LedgerRow, turns: number): LedgerItem {
    const item = toItem(row, turns);
    item.title = this.redact(item.title);
    if (item.condensed) item.condensed = this.redact(item.condensed);
    return item;
  }

  items(agentId: string, conversationId: string, opts: { since?: number; kinds?: LedgerKind[] } = {}): LedgerItem[] {
    const turns = this.turns(agentId, conversationId);
    return this.store.rows(agentId, conversationId, opts.since, opts.kinds).map((row) => this.item(row, turns));
  }

  mark(agentId: string, conversationId: string, marks: LedgerMark[]): void {
    if (!marks.length) return;
    const now = this.s.clock.now();
    this.s.db.tx(() => {
      const turns = this.turns(agentId, conversationId);
      let kept = this.store.pinnedTokens(agentId, conversationId, KEEP_PIN);
      for (const mark of marks) {
        const row = this.store.row(agentId, conversationId, String(mark.itemId ?? '').trim().toLowerCase());
        if (!row) continue;
        if (mark.by === 'subconscious' && !mark.onWord && row.pinned_until !== null && Number(row.pinned_until) >= turns) continue; // a pin holds against the subconscious's own tidying
        if (mark.by === 'subconscious' && Number(row.nested)) continue; // B-049 F9: nothing to save – the context never held it
        const condensed = (mark.condensed?.trim() || row.condensed || '').slice(0, CONDENSED_CHARS);
        if (mark.state === 'condensed' && !condensed) continue; // nothing to show in its place
        let pinnedUntil: number | undefined;
        if (mark.by === 'restore') {
          const held = Number(row.pinned_until ?? 0);
          const tokens = liveTokens({ tokens: Number(row.tokens), nested: Boolean(Number(row.nested)) }); // B-049 F9: a nested item takes no room
          if (held >= KEEP_PIN) pinnedUntil = mark.keep === false ? turns : KEEP_PIN; // keep: false lets it go (pinned this turn only)
          else if (mark.keep && kept + tokens <= KEEP_TOKENS) pinnedUntil = KEEP_PIN; // within the room kept for good
          else pinnedUntil = Math.max(turns + PIN_TURNS, held);
          kept += (pinnedUntil >= KEEP_PIN ? tokens : 0) - (held >= KEEP_PIN ? tokens : 0);
        }
        this.store.setMark(row, {
          state: mark.state, condensed: condensed || null, by: mark.by, reason: String(mark.reason ?? '').slice(0, REASON_CHARS), at: now,
          ...(pinnedUntil !== undefined ? { pinnedUntil } : {}),
        });
      }
    });
    try { prune(this.retention(), agentId, conversationId); } catch (error) { this.s.log.warn('context ledger retention failed', { agentId, conversationId, error: String(error) }); }
  }

  original(agentId: string, conversationId: string, itemId: string): { text: string; pruned: boolean; args?: string } | undefined {
    const row = this.store.row(agentId, conversationId, itemId.trim().toLowerCase());
    if (!row) return undefined;
    const deps = this.viewDeps();
    const found = originalOf(deps, row, ORIGINAL_CHARS);
    const args = found.pruned ? undefined : callArgsOf(deps, row);
    return { text: found.text, pruned: found.pruned, ...(args ? { args } : {}) };
  }

  view(agentId: string, conversationId: string): LedgerView {
    const deps = this.viewDeps();
    const out: LedgerViewItem[] = [];
    const rows = this.store.rows(agentId, conversationId);
    const gone = goneWithScript(deps, rows);
    for (const row of rows) {
      if (gone.has(row.item_id)) continue;
      try {
        const item = viewItem(deps, row);
        if (item) out.push(item);
      } catch (error) {
        this.s.log.warn('context ledger view item failed', { agentId, conversationId, itemId: row.item_id, error: String(error) });
      }
    }
    return out;
  }

  traceView(agentId: string, conversationId: string, limit: number): LedgerView {
    const deps = this.viewDeps();
    return this.store.traceRows(agentId, conversationId, limit).flatMap((row) => viewItem(deps, row) ?? []);
  }

  needsRebuild(agentId: string, conversationId: string): RebuildNeed | undefined {
    // B-049 F9: a nested row (a call inside a code-mode script) is never in the native session – its mark changes nothing there.
    const changed = this.store.changed(agentId, conversationId).filter((row) => !Number(row.nested));
    if (!changed.length) return undefined;
    const count = { condensed: 0, hidden: 0, restored: 0 };
    let saves = 0;
    let marked = false;
    for (const row of changed) {
      const tokens = Number(row.tokens);
      const condensedCost = estimateTokens(row.condensed ?? '') + STAMP_TOKENS;
      const held = row.applied === 'hidden' ? 0 : row.applied === 'condensed' ? condensedCost : tokens;
      const next = row.state === 'hidden' ? 0 : row.state === 'condensed' ? condensedCost : tokens;
      saves += held - next;
      marked ||= row.marked_by === 'subconscious' && row.state !== 'keep';
      if (row.state === 'keep') count.restored++;
      else count[row.state]++;
    }
    const parts = (Object.entries(count) as Array<[string, number]>).filter(([, n]) => n > 0).map(([what, n]) => `${n} ${what}`);
    return { since: Number(changed[0].order), reason: `${parts.join(', ')} since the last rebuild`, saves, marked };
  }

  rebuilt(agentId: string, conversationId: string, upTo: number): void {
    this.store.applied(agentId, conversationId, upTo);
  }

  capture(run: LedgerRun): void {
    if (!run.conversationId || !run.agentId) return;
    try { this.capturing.attach(run); } catch (error) { this.s.log.warn('context ledger capture failed', { runId: run.runId, error: String(error) }); }
  }

  /** Is this run attached (tests, diagnostics)? */
  attached(runId: string): LedgerRun | undefined {
    return this.captureCache?.attached(runId);
  }

  holds(runId: string): boolean {
    return this.attached(runId) !== undefined;
  }

  start(): () => void {
    const bus = this.s.bus;
    const stops = [
      bus.on('run.item', (item) => this.capturing.onItem(item)),
      bus.on('run.upserted', (run) => this.capturing.onRun(run)),
      bus.on('conversation.removed', ({ id }) => {
        try { forgetChat(this.retention(), id); } catch (error) { this.s.log.warn('context ledger: removed chat not cleared', { conversationId: id, error: String(error) }); }
      }),
      // The person's edit or delete reaches the ledger: no title keeps words that are gone.
      bus.on('message.removed', ({ id, conversationId }) => {
        try { this.store.forgetMessage(conversationId, id, this.s.clock.now()); } catch (error) { this.s.log.warn('context ledger: deleted message not cleared', { conversationId, error: String(error) }); }
      }),
      bus.on('message.updated', (message) => {
        try { this.messageChanged(message); } catch (error) { this.s.log.warn('context ledger: edited message not updated', { conversationId: message.conversationId, error: String(error) }); }
      }),
    ];
    const pass = setImmediate(() => {
      try { pruneAll(this.retention()); } catch (error) { this.s.log.warn('context ledger start-up retention failed', { error: String(error) }); }
    });
    (pass as { unref?: () => void }).unref?.();
    return () => { clearImmediate(pass); for (const stop of stops) stop(); };
  }

  private messageChanged(message: Message): void {
    for (const row of this.store.byMessage(message.conversationId, message.id)) {
      const line = this.renderMessage(message, row.agent_id);
      const title = ledgerTitle(line.replace(/^\[[^\]\n]{1,40}\]\s*/, ''), `Message #${message.seq}`);
      if (title !== row.title) this.store.retitle(row, title, estimateTokens(line));
      // Condensed or hidden before this edit: the mark described the old words – the new text shows again.
      if (row.state !== 'keep' && row.pruned_at === null && message.editedAt !== undefined && Number(row.marked_at ?? 0) <= message.editedAt) this.store.reopen(row, this.s.clock.now());
    }
  }

  /** The agent's turn count in the chat (the unit of a pin): the turns that captured items, plus its running turn
   *  when that one captured nothing yet (a continuation without new lines that restores first – else the pin ends a turn early). */
  turns(agentId: string, conversationId: string): number {
    const counted = this.store.turns(agentId, conversationId);
    const running = this.captureCache?.attachedFor(agentId, conversationId) ?? [];
    return counted + (running.some((runId) => !this.store.hasRun(agentId, conversationId, runId)) ? 1 : 0);
  }

  /** The person's Forget – the ledger's copies and the originals that mention it (forget.ts). */
  forget(match: (text: string) => boolean): LedgerForget {
    return forgetInLedger(this.retention(), match);
  }

  /** Raw rows for the restore tool's search (title and condensed text). */
  rowsOf(agentId: string, conversationId: string): LedgerRow[] {
    return this.store.rows(agentId, conversationId);
  }
}
