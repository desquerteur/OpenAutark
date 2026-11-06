// What a run of the subconscious is told about the chat: the lines of a finished exchange (the person's and the agents',
// so a bare "ja" stands beside the proposal it answers, with what the agent's tools read, ran and saved in that turn), or as
// much of the chat as the main AI's own call asked for. All of
// it redacted before it is cut, the newest kept within the cap. The person's lines carry a neutral label: a name in front of every line
// read as something the message names and went into the queries (live 02.11.2026: 14 of 23).
// Owns: which lines go along and their form. Never: changes a message or calls a model.

import type { RuntimeServices } from '../contracts.ts';
import type { Message } from '../../shared/model/chat.ts';
import type { Agent } from '../../shared/model/org.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { latestObservation } from '../context/observations.ts';
import { fromPerson } from '../agents/publishing.ts';
import '../contracts/ledger.ts';

const MESSAGE_CHARS = 1500;
const REPLY_CHARS = 2000;
const EXCHANGE_CHARS = 6000;
const RECENT_LINES = 12;
const CHAT_LINES = 60;
const CHAT_CHARS = 12_000;
const STATE_CHARS = 4000;
const PAGE = 200;
const PERSON = 'The person';
const EARLIER_CHARS = 2000;
/** The calls that write memory, as their transcript line begins. */
const SAVES = /^(?:knowledge\.remember|memory\.write|references\.remember):\s*(?:Remember\b)?/;
/** The main AI's other calls of a turn a run is told about, each as its transcript line: enough to see where its reply came from. */
const USED_LINES = 6;
const USED_CHARS = 140;
/** The subconscious's own calls in the main AI's history (its notes, the marks call): not the main AI's sources. */
const OWN_CALLS = /^subconscious:/;

interface ExchangeTurn { agent: Pick<Agent, 'id' | 'name'>; conversationId?: string; fromSeq: number; toSeq: number; reply: string; runId?: string }

/** How much of the chat goes along with the main AI's own call. */
export type AskContext = 'none' | 'recent' | 'chat';

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max).trimEnd()} …` : trimmed;
}

function redactor(services: RuntimeServices): (text: string) => string {
  return (text) => (services.secrets ? services.secrets.redact(text) : text);
}

function nameOf(services: RuntimeServices, authorId: string): string {
  try {
    if (authorId === HUMAN_ID) return PERSON;
    return services.org.get(authorId)?.name ?? services.people?.nameOf(authorId) ?? 'Contact';
  } catch {
    return PERSON;
  }
}

/** "Name: text" lines, newest kept within `max` characters. */
function linesOf(services: RuntimeServices, messages: readonly Message[], max: number): string[] {
  const redact = redactor(services);
  const lines: string[] = [];
  let used = 0;
  for (const message of [...messages].reverse()) {
    if (message.kind === 'status' || !message.body.trim()) continue;
    const line = `${nameOf(services, message.authorId)}: ${clip(redact(message.body), MESSAGE_CHARS)}`;
    if (lines.length && used + line.length > max) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines;
}

/** The lines of a chat after `fromSeq` up to `toSeq`. */
function rangeOf(services: RuntimeServices, conversationId: string, fromSeq: number, toSeq: number): Message[] {
  return services.chats.messages(conversationId, { beforeSeq: toSeq + 1, limit: PAGE }).filter((message) => message.seq > fromSeq);
}

/** What people said after `fromSeq` up to `toSeq`, for the wake check ('' without a chat). */
export function saidBetween(services: RuntimeServices, agentId: string, conversationId: string | undefined, fromSeq: number, toSeq: number): string {
  if (!conversationId || toSeq <= fromSeq) return '';
  return rangeOf(services, conversationId, fromSeq, toSeq).filter((message) => fromPerson(message, agentId)).map((message) => message.body).join('\n');
}

/**
 * What the agent's tools did in this run, by the lines its calls left in the transcript: what it saved itself (a run after it would keep the
 * same thing again) and what it read or ran, so its reply's facts have their source (q-r1b2 #32, 03.11.2026: a detail the main AI had read
 * from a file went into memory as a new fact; q-r1a2 #6: a rule it had found in memory was copied into the chat's folder).
 */
function toolLines(services: RuntimeServices, turn: ExchangeTurn): string[] {
  if (!turn.conversationId || !turn.runId) return [];
  try {
    const items = (services.ledger?.items(turn.agent.id, turn.conversationId) ?? []).filter((item) => item.runId === turn.runId);
    const saved = items.filter((item) => SAVES.test(item.title)).map((item) => `${turn.agent.name} saved: ${item.title.replace(SAVES, '').trim()}`);
    const used = [...new Set(items.filter((item) => (item.kind === 'tool' || item.kind === 'file') && !SAVES.test(item.title) && !OWN_CALLS.test(item.title)).map((item) => clip(item.title, USED_CHARS)))].slice(0, USED_LINES);
    return [...(used.length ? [`What ${turn.agent.name}'s tools read or ran in this turn, not new:\n${used.join('\n')}`] : []), ...saved];
  } catch {
    return [];
  }
}

/**
 * A finished exchange: its chat lines and the agent's reply (which may have stayed in the run log). What stands before the person's first
 * line here is the agent's earlier answer: it belongs to a bare "ja", but it is not new (live 02.11.2026: q1 #14, q1b #20 kept it as new).
 */
export function exchangeText(services: RuntimeServices, turn: ExchangeTurn): string {
  const range = turn.conversationId ? rangeOf(services, turn.conversationId, turn.fromSeq, turn.toSeq) : [];
  const first = range.findIndex((message) => fromPerson(message, turn.agent.id));
  const earlier = first > 0 ? linesOf(services, range.slice(0, first), EXCHANGE_CHARS) : [];
  const lines = linesOf(services, first > 0 ? range.slice(first) : range, EXCHANGE_CHARS);
  const reply = clip(redactor(services)(turn.reply), REPLY_CHARS);
  const said = reply && !lines.some((line) => line.endsWith(reply)) ? [`${turn.agent.name} replied: ${reply}`] : [];
  return [...(earlier.length ? [`Before this exchange, not new:\n${earlier.join('\n')}\n\nThe exchange:`] : []), ...lines, ...said, ...toolLines(services, turn)].join('\n');
}

/** For a run that has the transcript in front of it: what the person said earlier too, because what they asked about it still holds. */
export function tidyText(services: RuntimeServices, turn: ExchangeTurn): string {
  const said = turn.conversationId ? services.chats.messages(turn.conversationId, { beforeSeq: turn.fromSeq + 1, limit: RECENT_LINES }).filter((message) => fromPerson(message, turn.agent.id)) : [];
  const before = linesOf(services, said, EARLIER_CHARS);
  return [...(before.length ? [`What the person said earlier in this chat, not new:\n${before.join('\n')}\n`] : []), exchangeText(services, turn)].filter(Boolean).join('\n');
}

/** The chat that goes along with the main AI's own call. */
export function askContext(services: RuntimeServices, input: { agentId: string; conversationId?: string; context?: AskContext }): string {
  const context = input.context ?? 'recent';
  if (context === 'none' || !input.conversationId) return '';
  const limit = context === 'chat' ? CHAT_LINES : RECENT_LINES;
  const lines = linesOf(services, services.chats.messages(input.conversationId, { limit }), context === 'chat' ? CHAT_CHARS : EXCHANGE_CHARS);
  const state = context === 'chat' ? latestObservation(services, input.conversationId, input.agentId, { ownOnly: true })?.body : undefined;
  return [state ? `Summary of the earlier chat:\n${clip(redactor(services)(state), STATE_CHARS)}` : '', ...lines].filter(Boolean).join('\n');
}
