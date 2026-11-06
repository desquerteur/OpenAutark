// Steering for important messages: the chat lines a running turn has not seen yet (after
// max(control.lastSeq, control.steeredSeq)), rendered briefly and handed to engine.steer().
// Each line has the delta's form – "[HH:MM] Name: (important) text", a quiet one "[HH:MM] Name (quiet): text"
// (B-050 K5, shared/model/chat.ts messageLevel), a text message about a task ending with " [task <id>]" and a
// model tag with " (suggested model: …)" (render.ts modelNote) – stamped in the person's
// zone and named by context/render.ts authorName (the person by the profile name, "(agent)" on an
// org member called like the person, "(external agent)" / "(external contact)" for 'ext:'
// members, C8) – and its body is neutralized like the delta's: no body line can start with a
// "[…] " stamp, so none can pose as another author's line.
// C6: a reply says whom it answers and the person's edit/delete notices read as in the delta
// (context/render.ts replyLine, changeNotice – none when it adds nothing).
// Lines steering cannot carry in full stop it before them (`held`; the next turn's delta brings them,
// the caller interrupts or waits): files – the delta gives paths, images, extracted text and
// transcripts, a steered line only names – and lines said live (speech.live or a call line, meta.call: a
// live voice conversation waits for an answer written after its message, shared/voice/conversation.ts).
// A dictated line is folded like a typed one (23.10.).
// D15 relays (calls/talker.ts, through dispatcher.relay): a live voice's framed text – complete plain text, not
// a raw call line, so heldBack does not apply – goes into the running turn as it is (steerRelay); 'next' only
// on an engine whose steered text waits for the turn's next model request (LANDS_AT_NEXT_REQUEST – Claude Code
// answers every steered line on its own, so there a digest line waits for the next turn instead). It moves no
// cursor: the call lines it speaks of reach the next turn's delta as usual.
// Owns: that rendering, the steer call and control.steeredSeq after a successful steer.
// Never: includes the agent's own lines or other status lines, skips past a line that is still
// streaming or held back (it must reach the agent later in full; a background run's silent live row holds no text and
// is passed – its answer takes a new seq at the end), advances the member cursor, or shows the
// owner's Telegram line (C9) without the note the delta gives it (context/render.ts) – a steered
// line is not delivered again.

import type { RuntimeServices } from '../contracts.ts';
import { secretLines } from '../secrets/metadata.ts';
import { messageLevel, type Message } from '../../shared/model/chat.ts';
import { fromBridgeOwner } from '../../shared/model/bridges.ts';
import { renderContext } from '../context/delta.ts';
import { BRIDGE_OWNER_NOTE, authorName, changeNotice, lineIndex, modelNote, neutralize, replyLine, type RenderContext } from '../context/render.ts';
import { stampText } from '../context/time.ts';
import { ultraNote } from '../context/split-section.ts'; // B-057 S17: a steered line that suggested Ultra keeps its note
import type { EngineId } from '../../shared/model/providers.ts';
import type { TurnControl } from './turn-types.ts';

const MAX_LINES = 50;
const MAX_BODY = 2000;

export interface SteerInput {
  /** Text for engine.steer ('' when only own/status lines were new). */
  text: string;
  /** Highest seq covered; becomes control.steeredSeq after a successful steer. */
  lastSeq: number;
  lines: number;
  /** A line after lastSeq waits for the next turn (files, speech): the turn does not have every line. */
  held?: boolean;
}

/** A line steering cannot carry in full: files or a live/call line (see the header). */
export function heldBack(message: Message): boolean {
  if (message.attachments.length > 0 || message.meta?.call !== undefined) return true;
  const speech = message.meta?.speech;
  if (speech) return speech.live === true;
  return message.meta?.via === 'voice'; // an older spoken line without speech meta
}

function render(ctx: RenderContext, message: Message, byId: ReadonlyMap<string, Message>): string {
  const body = neutralize(message.body.length > MAX_BODY ? `${message.body.slice(0, MAX_BODY)}…` : message.body).trim();
  const level = messageLevel(message);
  const flag = level === 'important' ? '(important) ' : '';
  const task = message.kind === 'text' && message.taskId ? ` [task ${message.taskId}]` : '';
  const via = fromBridgeOwner(message) ? ` ${BRIDGE_OWNER_NOTE}` : '';
  const reply = replyLine(ctx, message, byId);
  const secrets = secretLines(ctx.services, ctx.agentId, message.meta?.secrets).join('\n');
  const header = `[${stampText(message.createdAt, ctx.zone, ctx.now)}] ${authorName(ctx, message)}${level === 'silent' ? ' (quiet)' : ''}`;
  return `${header}: ${reply ? `${reply} ` : ''}${flag}${body}${task}${modelNote(ctx, message)}${ultraNote(message)}${via}${secrets ? `\n${secrets}` : ''}`;
}

/** Unseen lines of `conversationId` for `agentId` after `afterSeq`; undefined when nothing is new. */
export function steerInput(services: RuntimeServices, agentId: string, conversationId: string, afterSeq: number): SteerInput | undefined {
  const messages = services.chats.messages(conversationId, { afterSeq, limit: MAX_LINES });
  const ctx = renderContext(services, agentId);
  const { byId, latest } = lineIndex(messages);
  let lastSeq = afterSeq;
  let held = false;
  const lines: string[] = [];
  for (const message of messages) {
    const own = message.authorId === agentId;
    if (!own && message.state === 'streaming') {
      if (!message.silent) break; // deliver it later, complete
      lastSeq = message.seq; // a background run's silent live row holds no text: its answer comes at the end
      continue;
    }
    if (!own && message.kind !== 'status' && heldBack(message)) { held = true; break; } // the next turn brings it in full
    lastSeq = message.seq;
    const notice = message.kind === 'status' ? changeNotice(ctx, message, byId, latest) : undefined;
    if (notice) { lines.push(`· ${notice}`); continue; } // C6: an edit/delete notice, as in the delta
    if (own || message.kind === 'status') continue;
    lines.push(render(ctx, message, byId));
  }
  if (lastSeq === afterSeq && !held) return undefined;
  const text = lines.length ? `New messages in this chat while I am working:\n${lines.join('\n')}` : '';
  return { text, lastSeq, lines: lines.length, ...(held ? { held } : {}) };
}

/**
 * Steers the unseen lines of `conversationId` into a running turn. True when the turn now has
 * every line (steered, or nothing was new); false when the engine cannot take it or a line is held
 * back (the caller interrupts or the queued wake runs next). Advances `control.steeredSeq` only
 * after a successful steer, and never past a held-back line.
 */
export async function steerTurn(
  services: RuntimeServices,
  run: { agentId: string; runId: string; control: TurnControl },
  conversationId: string,
  stillRunning: () => boolean,
): Promise<boolean> {
  const engine = run.control.engine;
  if (!engine?.steer) return false;
  let input: SteerInput | undefined;
  try { input = steerInput(services, run.agentId, conversationId, Math.max(run.control.lastSeq, run.control.steeredSeq)); } catch (error) {
    services.log.warn('steer input failed', { agentId: run.agentId, error: String(error) });
    return false;
  }
  if (!input) return true; // the running turn already has every line
  if (input.text) {
    let ok = false;
    try { ok = await engine.steer(run.runId, input.text); } catch (error) {
      services.log.info('steer failed', { agentId: run.agentId, error: String(error) });
    }
    if (!ok || !stillRunning()) return false;
    try { services.runs.item(run.runId, { kind: 'note', data: { steered: { lines: input.lines, upToSeq: input.lastSeq } }, effectStatus: 'none' }); } catch { /* audit is best effort */ }
  }
  run.control.steeredSeq = Math.max(run.control.steeredSeq, input.lastSeq);
  return !input.held;
}

/** Engines whose steered text waits for the running turn's next model request (Codex turn/steer, the HTTP loop) – a soft 'next' relay. */
export const LANDS_AT_NEXT_REQUEST: ReadonlySet<EngineId> = new Set<EngineId>(['codex', 'openai', 'anthropic', 'compatible']);

/**
 * D15: a live voice's relay text into the running turn (calls/talker.ts). 'now': any engine that steers;
 * 'next': only one of LANDS_AT_NEXT_REQUEST. True when the turn took it and still runs (journaled as a run
 * note); false = not steered (the caller interrupts, digests or wakes). Never moves a cursor.
 */
export async function steerRelay(
  services: RuntimeServices,
  run: { agentId: string; runId: string; control: TurnControl },
  text: string,
  mode: 'now' | 'next',
  stillRunning: () => boolean,
): Promise<boolean> {
  const engine = run.control.engine;
  if (!engine?.steer || !text.trim()) return false;
  if (mode === 'next' && !LANDS_AT_NEXT_REQUEST.has(engine.id)) return false;
  let ok = false;
  try { ok = await engine.steer(run.runId, text); } catch (error) {
    services.log.info('relay steer failed', { agentId: run.agentId, error: String(error) });
  }
  if (!ok || !stillRunning()) return false;
  try { services.runs.item(run.runId, { kind: 'note', data: { relayed: { mode, chars: text.length } }, effectStatus: 'none' }); } catch { /* audit is best effort */ }
  return true;
}
