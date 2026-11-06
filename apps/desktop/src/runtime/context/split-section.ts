// B-057 S5/S17 – the volatile prompt sections of splits (context/prompt-volatile.ts). A split's own turn (thread
// `split:<id>`) gets 'split': who it is ("I am split #k of N of <Agent>"), the goal its main self split, its part, the
// other parts (titles only) and how it works as a split – and it leaves out the sections that belong to its main self (SPLIT_SKIP: the
// open tasks, schedules, setup facts). An agent's own turn on a
// thread where its split groups are still at work gets the one 'splits' line (R1-4: which groups, how far). S17 as the
// owner set it on 30.10.2026: splitting is the agent's own free choice – the environment names it in one line
// (environment.ts splitLine) and a person's message with Ultra suggested carries ULTRA_NOTE where it is rendered
// (render.ts, dispatch-steer.ts); there is no standing Ultra rule and no chat switch. B-075 (owner 04.11.2026): these
// texts speak as the agent itself, in the first person.
// Owns: those texts and which sections a split leaves out. Never: carries a part's brief (the split turn's input notes
// do), decides anything about a split's lifecycle, or shows another agent's work.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import { isSplitThread, splitThread, type SplitGroupView, type SplitView } from '../../shared/model/splits.ts';
import { excerpt } from '../../shared/text/chat-names.ts';

/** Sections a split's turn leaves out: its main self's. */
export const SPLIT_SKIP: ReadonlySet<string> = new Set(['setup', 'tasks', 'schedules']);

/**
 * S17 (owner 30.10.2026: "Ultra ist ein Modus, dass der Agent selber wählen kann … nur eine Möglichkeit"): the note on a
 * person's message that suggested Ultra – a hint for that message; whether and how to split stays the agent's call.
 * (The earlier standing per-chat rule, "split every substantive request first", is gone: the owner never wanted a rule.)
 */
export const ULTRA_NOTE = '(Ultra suggested: the person thinks splitting this with agents.split could help – whether I split is my call)';

/** ' ' + ULTRA_NOTE for a person's message that suggested Ultra (meta.ultra), '' otherwise – never on an agent's line. */
export function ultraNote(message: { authorKind?: string; meta?: { ultra?: unknown } }): string {
  return message.authorKind === 'human' && message.meta?.ultra === true ? ` ${ULTRA_NOTE}` : '';
}

/** A split turn's facts as the split service has them (both absent when it does not know the split). */
export interface SplitFacts { split?: SplitView; group?: SplitGroupView }

/** The facts of a split's thread; undefined for every other thread. */
export function splitFacts(services: Pick<RuntimeServices, 'splits' | 'log'>, thread: string | undefined): SplitFacts | undefined {
  if (!thread || !isSplitThread(thread)) return undefined;
  try {
    const found = services.splits?.get(thread.slice(splitThread('').length));
    return found ? { split: found.split, group: found.group } : {};
  } catch (error) {
    services.log?.debug('split facts unavailable', { thread, error: String(error) });
    return {};
  }
}

/** The 'split' section (S5): identity, part, the other parts and how a split works. */
export function splitSection(agent: Pick<Agent, 'name'>, facts: SplitFacts): string {
  const { split, group } = facts;
  const lines = split
    ? [
      `## Split ${split.idx} of ${split.of}`,
      `I am split #${split.idx} of ${split.of} of ${agent.name}. My main self split its work just now${group?.goal ? ` (goal: ${excerpt(group.goal, 400)})` : ''}.`,
      `My part: #${split.idx} ${excerpt(split.title, 80)}.`,
    ]
    : ['## Split', `I am a split of ${agent.name}: my main self split its work just now; my part is in my input.`];
  const others = (group?.splits ?? []).filter((item) => item.id !== split?.id).map((item) => `#${item.idx} ${excerpt(item.title, 80)}`);
  if (others.length) lines.push(`Other parts (not mine): ${others.join('; ')}.`);
  if (split?.returns) lines.push(`I bring back: ${excerpt(split.returns, 400)}`);
  lines.push(
    'As a split:',
    '- I keep to my part – the other parts run in parallel.',
    '- I post nothing in chats and ask nobody (no person, no colleague): I decide and say what stayed open.',
    '- Splitting again, delegating, handing off, remembering for later and changing agents, settings, schedules, modes or models are my main self\'s (so is the Splitting line of my environment).',
    '- My final text goes back to my main self, which merges the parts: I make it the complete result of my part.',
    split?.worktree
      ? `- Files: I work in my own git worktree${split.branch?.name ? ` (branch ${split.branch.name})` : ''} – I change what my part needs there and leave it uncommitted: the app commits my work on that branch when I end; my main self merges it.`
      : '- Files: I share the working folder with the other parts – I keep to the files of my part.',
  );
  return lines.join('\n');
}

/** At most this many groups in the 'splits' line (SPLIT_LIMITS.activeGroupsPerAgent keeps an agent there anyway). */
export const ACTIVE_SHOWN = 3;
export const ACTIVE_HEADER = '## My splits here';

/**
 * R1-4: the 'splits' line of an agent's own turn – its groups still at work on this thread (pending or running), so it
 * neither redoes their parts nor says they are finished. '' for a split's turn and without such groups, so the volatile
 * prompt of a chat without splits at work stays as it was.
 */
export function activeSplitsLine(services: Pick<RuntimeServices, 'splits'>, agentId: string, thread: string | undefined): string {
  if (!thread || isSplitThread(thread)) return '';
  const groups = (services.splits?.activeOn?.(agentId, thread, ACTIVE_SHOWN) ?? []).slice(0, ACTIVE_SHOWN);
  if (!groups.length) return '';
  const items = groups.map((group) => {
    const state = group.status === 'pending' ? `${group.parts} parts, not started yet`
      : `${group.done} of ${group.parts} done, ${group.running} running${group.ended ? `, ${group.ended} did not finish` : ''}`;
    return `group ${group.id} "${excerpt(group.goal, 120)}" – ${state}`;
  });
  // A header, so a resumed session's delta names it "My splits here" (agents/volatile-delta.ts sectionTitle).
  return `${ACTIVE_HEADER}\nStill at work: ${items.join('; ')}. Their results come to me when all their parts have ended.`;
}
