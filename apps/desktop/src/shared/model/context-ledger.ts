// Context ledger (B-048 E1, back 01.11.2026): every unit of an agent's working context in a chat has a short, stable id –
// m<seq> a chat message (its seq), t<n> a tool call with its output (ours or engine-native), s<n> a loaded
// skill text, r<n> a reasoning summary, a<n> the agent's own text (commentary or answer), f<n> file content
// read. <n> counts per (agent, chat) across t/s/r/a/f and is never reused. A row keeps its title and its
// condensed text for good, so an id never dangles; the original (a message, a run item, a blob) is kept
// at least 14 days after it was condensed or hidden, within 64 MB per (agent, chat).
// B-049 F9: a NESTED item is a call a code-mode script ran inside one engine call (Codex `exec`: the model saw only
// the script and what it printed, never this call's output) – its engine call id starts with "exec-" (Codex names
// every call made inside an exec script so; checked against the rollouts and codex-cli 0.165). It stays in the ledger
// (context.restore returns its output) but costs nothing in the live context and is never replayed on its own.
// Owns: the shapes, the id rules, the token estimate (about four characters per token), the live-context cost (a
// nested item 0), the nested-call rule, the title cap and the restore stamp of a condensed item. Never: storage or
// capture (runtime/context/ledger/*).

export type LedgerKind = 'message' | 'tool' | 'skill' | 'reasoning' | 'assistant' | 'file';
export type LedgerState = 'keep' | 'condensed' | 'hidden';
/** Who set a mark: the subconscious, the agent itself, or a restore. */
export type MarkBy = 'subconscious' | 'agent' | 'restore';

/** Id letter per kind. */
export const KIND_PREFIX: Readonly<Record<LedgerKind, string>> = { message: 'm', tool: 't', skill: 's', reasoning: 'r', assistant: 'a', file: 'f' };
const KIND_OF_PREFIX: Readonly<Record<string, LedgerKind>> = { m: 'message', t: 'tool', s: 'skill', r: 'reasoning', a: 'assistant', f: 'file' };
export const LEDGER_KINDS: readonly LedgerKind[] = ['message', 'tool', 'skill', 'reasoning', 'assistant', 'file'];
const ITEM_ID = /^([mtsraf])([1-9]\d{0,11})$/;

/** Titles are at most this long. */
export const TITLE_CHARS = 120;
/** A restore pins the restored items for this many of the agent's turns in the chat (the subconscious leaves them alone). */
export const PIN_TURNS = 3;

export interface LedgerOrigin {
  /** Engine that produced the item (codex, claude, an HTTP engine …); none for chat messages. */
  engine?: string;
  /** Catalog model id of the producing turn. */
  model?: string;
}

/** One ledger row as callers read it. */
export interface LedgerItem {
  agentId: string;
  conversationId: string;
  itemId: string;
  kind: LedgerKind;
  /** The run that captured it (for an m item: the turn that delivered the message). */
  runId?: string;
  /** Monotonic position per (agent, chat). */
  order: number;
  createdAt: number;
  /** Estimate of what the item costs in context as captured (characters / 4). */
  tokens: number;
  title: string;
  state: LedgerState;
  condensed?: string;
  /** Set only while the pin holds (a turn count of the ledger; expired pins read as unset). */
  pinnedUntil?: number;
  origin: LedgerOrigin;
  /** Where the original is: 'msg:<message id>', 'item:<run item id>' (the journal row; a big tool output is a blob it names). */
  ref?: string;
  /** The original is gone (retention); title and condensed text stay. */
  pruned?: boolean;
  markedBy?: MarkBy;
  markReason?: string;
  /** B-049 F9: a call a code-mode script ran inside one engine call – 0 tokens of the live context (liveTokens), never condensed or hidden. */
  nested?: boolean;
}

/** What a capture hands to record(). */
export interface NewLedgerItem {
  kind: LedgerKind;
  /** m items: the chat message's seq (the id is m<seq>). */
  seq?: number;
  runId?: string;
  title?: string;
  /** The text as the agent holds it – estimates `tokens` when that is not given. */
  text?: string;
  tokens?: number;
  /** Where the original is (see LedgerItem.ref); a second record with the same ref updates that row. */
  ref?: string;
  origin?: LedgerOrigin;
  /** Size of an original kept in a blob (counts toward the retention budget); 0 when it lives elsewhere. */
  bytes?: number;
  createdAt?: number;
}

export interface LedgerMark {
  itemId: string;
  state: LedgerState;
  /** Required for 'condensed' unless the item has condensed text already. */
  condensed?: string;
  reason: string;
  by: MarkBy;
  /**
   * B-050 K5: with by 'restore', true pins for good (pinned_until = KEEP_PIN, within KEEP_TOKENS per agent and chat –
   * beyond that the PIN_TURNS pin applies); false ends a pin for good (context.restore keep: false).
   */
  keep?: boolean;
  /** With by 'subconscious': the mark comes from a run on someone's word (the person's message, the main AI's own call), which a pin does not stop. */
  onWord?: boolean;
}

/** One entry of the view – what the next native rebuild contains, in order. */
export interface LedgerViewItem {
  itemId: string;
  kind: LedgerKind;
  role: 'user' | 'assistant' | 'tool';
  /** The original (tool outputs capped like a model sees them), or the condensed text with its stamp. */
  text: string;
  /** The restore stamp of a condensed item (also appended to `text`). */
  stamp?: string;
  /** Tool, skill and file items: the call with its (or the condensed) output. `args`: the journal's preview, parsed when it is JSON. */
  call?: { name: string; args: unknown; callId: string; output: string; own?: boolean; ok?: boolean };
  origin: LedgerOrigin;
  /** Additions to the contract shape: the item's order and its run. */
  order: number;
  runId?: string;
  state: Exclude<LedgerState, 'hidden'>;
  /** B-049 F9: a call made inside a code-mode script (see LedgerItem.nested) – a rebuild never replays it as a call of its own. */
  nested?: boolean;
}

export type LedgerView = LedgerViewItem[];

/** The token estimate used everywhere in the ledger: about four characters per token. */
export function estimateTokens(text: string | undefined): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/** B-049 F9: the engine call id prefix of a call made inside a code-mode script (Codex `exec`). */
export const NESTED_CALL_PREFIX = 'exec-';

/** B-049 F9: a call a code-mode script ran (its output reached the script, not the model's context). */
export function isNestedCall(callId: string | undefined | null): boolean {
  return typeof callId === 'string' && callId.startsWith(NESTED_CALL_PREFIX);
}

/** B-049 F9: what an item costs in the live context – its estimate, a nested call nothing. */
export function liveTokens(item: { tokens: number; nested?: boolean | null }): number {
  return item.nested ? 0 : Math.max(0, Number.isFinite(item.tokens) ? item.tokens : 0);
}

/** The kind of an item id ('t17' → 'tool'); undefined for any other shape. */
export function kindOfId(itemId: string): LedgerKind | undefined {
  const match = ITEM_ID.exec(itemId.trim());
  return match ? KIND_OF_PREFIX[match[1]] : undefined;
}

/** A well-formed item id: lower-case letter + positive number ('#12' and 'M12' read as 'm12'). */
export function normalizeItemId(value: string): string | undefined {
  const raw = value.trim().toLowerCase().replace(/^#(\d+)$/, 'm$1');
  return ITEM_ID.test(raw) ? raw : undefined;
}

/** One line, at most TITLE_CHARS characters. */
export function ledgerTitle(text: string | undefined, fallback = 'item'): string {
  const line = (text ?? '').replace(/\s+/g, ' ').trim() || fallback;
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** The stamp a condensed item carries, verbatim JSON: {"compacted":"t17","was":"1240 tokens","restore":"context.restore"}. */
export function compactStamp(itemId: string, tokens: number, gone = false): string {
  return JSON.stringify({ compacted: itemId, was: `${Math.max(0, Math.round(tokens))} tokens`, ...(gone ? { original: 'gone' } : { restore: 'context.restore' }) });
}
