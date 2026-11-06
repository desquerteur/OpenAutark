// When the subconscious wakes (owner 01.11.2026, 28.10.2026): often, but not every round. These checks cost no model and
// decide whether one runs at all: a person's message with content (not a bare "mach das" or "ja bitte"), a task that
// ended, an agent nearing its context limit, a planned model switch, another task, or every few turns; each such run also has
// the transcript in front of it (after-turn.ts). The main AI's own call (subconscious tool) needs no check. Never while a tool
// call waits for its output (toolWaiting).
// Owns: those rules and their thresholds. Never: calls a model, reads or writes memory.

import type { RuntimeServices } from '../contracts.ts';
import { foldText } from '../knowledge/normalize.ts';
import { nearLimit } from '../agents/compaction-policy.ts';

export type WakeWhy = 'task-ended' | 'limit' | 'switch' | 'person' | 'other-task' | 'turns';

/** A run at the latest after this many turns. */
export const EVERY_TURNS = 3;
/** While near the limit: a next run only after this many more tokens. */
const LIMIT_STEP_TOKENS = 4000;
const MIN_CHARS = 6;

/** Words of a greeting, thanks, a yes or no, or a bare go-ahead: a message of only these holds nothing to look up or keep. */
const NO_CONTENT: ReadonlySet<string> = new Set([
  'hi', 'hey', 'hallo', 'hello', 'moin', 'servus', 'na', 'guten', 'good', 'morgen', 'morning', 'tag', 'abend', 'evening',
  'danke', 'dank', 'vielen', 'thanks', 'thank', 'you', 'thx', 'super', 'cool', 'top', 'perfekt', 'prima', 'klasse', 'toll',
  'great', 'nice', 'wie', 'gehts', 'geht', 'es', 'dir', 'how', 'are', 'bye', 'tschuss', 'ciao', 'lol', 'haha',
  'ja', 'yes', 'yep', 'yeah', 'jo', 'ok', 'okay', 'nein', 'no', 'nope', 'klar', 'sure', 'gerne', 'bitte', 'please', 'genau', 'passt',
  'einverstanden', 'stimmt', 'agreed', 'right', 'gut', 'fine', 'alles',
  'mach', 'mache', 'machen', 'macht', 'das', 'dies', 'tu', 'tue', 'so', 'los', 'weiter', 'jetzt', 'dann', 'und', 'nur', 'einfach',
  'do', 'it', 'that', 'this', 'go', 'ahead', 'continue', 'now', 'then', 'and', 'just',
]);

const wordsOf = (text: string): string[] => foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** A person's words worth a model: more than a few characters and more than greetings, thanks, yes/no and go-aheads. */
export function hasContent(text: string): boolean {
  return text.trim().length >= MIN_CHARS && !wordsOf(text).every((word) => NO_CONTENT.has(word));
}

/** What the wake check knows per agent and chat since the last run. */
export interface WakeState {
  /** Finished turns since the last run. */
  turns: number;
  /** Context tokens when a run last looked at the transcript (or at the chat's first turn, or lower when a rebuild shrank it). */
  tokens?: number;
  /** The last turn's task. */
  taskId?: string;
}

export interface TurnFacts {
  /** What people said in this turn's input. */
  said: string;
  taskId?: string;
  taskEnded?: boolean;
  /** The turn asked for another model (model.set). */
  switchPlanned?: boolean;
  contextTokens?: number;
  contextWindow?: number;
  /** What a run could take off the transcript now (context-tools.ts savableTokens). */
  savable?: number;
}

/** Why a finished turn wakes the subconscious, or undefined (no model runs). `state` is before this turn counts. */
export function wakeAfterTurn(facts: TurnFacts, state: WakeState): WakeWhy | undefined {
  if (facts.taskEnded) return 'task-ended';
  const tokens = facts.contextTokens;
  const grown = tokens !== undefined && state.tokens !== undefined ? tokens - state.tokens : 0;
  const savable = facts.savable ?? 0;
  if (savable > 0 && tokens !== undefined && nearLimit(tokens, facts.contextWindow) && (state.tokens === undefined || grown >= LIMIT_STEP_TOKENS)) return 'limit';
  if (facts.switchPlanned) return 'switch';
  if (hasContent(facts.said)) return 'person';
  if (facts.taskId && state.taskId && facts.taskId !== state.taskId) return 'other-task';
  return state.turns + 1 >= EVERY_TURNS ? 'turns' : undefined;
}

/** A tool call of the agent's running turn in this chat waits for its output (its tool boundary, dispatch-boundary.ts). */
export function toolWaiting(services: RuntimeServices, agentId: string, conversationId: string | undefined): boolean {
  try {
    return services.dispatcher.activity().some((run) => run.agentId === agentId && run.conversationId === conversationId && (run.toolCalls ?? 0) > 0);
  } catch {
    return false;
  }
}
