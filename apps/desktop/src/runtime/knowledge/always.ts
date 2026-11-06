// One "always" rule (B-078 D12): what always stands in the main AI's prompt is one set – the skills marked
// `metadata.always: true` (skills/service.ts alwaysFor) and the memory files in a pinned/ folder (knowledge/service.ts
// pinned) – under one cap, ALWAYS_CHARS: a short text whole, a long one by its description with where to read it. Order is
// fixed (skills alphabetical, then the notes oldest first), so the same set gives the same text. It is rendered in the
// volatile "pinned" section (context/prompt-volatile.ts): a pinned note belongs to a chat and carries the day it was saved,
// and a change to one renews no native session (the stable prefix stays as it is, B-059).
// Owns: the set, its cap and its lines. Never: anything else from memory, or a body longer than its cap.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { KnowledgeItem, ModeInfo, SkillInfo } from '../../shared/model/knowledge.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import { savedText } from './age.ts';

/** The one cap of everything that always stands in the prompt. */
export const ALWAYS_CHARS = 3600;
/** A text up to this size stands whole; a longer one by its description. */
export const WHOLE_CHARS = 1200;
const DESCRIPTION_CHARS = 300;

export interface AlwaysSet { skills: SkillInfo[]; notes: KnowledgeItem[] }

/** The always-skills this agent's route reaches in this mode and the pinned notes of its places (and this chat). */
export function alwaysSet(services: RuntimeServices, agent: Agent, mode: ModeInfo | undefined, conversationId?: string): AlwaysSet {
  let skills: SkillInfo[] = [];
  try { skills = mode ? services.skills.alwaysFor?.(agent, mode) ?? [] : []; } catch { skills = []; }
  let notes: KnowledgeItem[] = [];
  try { notes = services.knowledge.pinned(agent.id, conversationId); } catch { notes = []; }
  return { skills: [...skills].sort((a, b) => a.name.localeCompare(b.name)), notes };
}

function skillLine(services: RuntimeServices, agent: Agent, skill: SkillInfo): string {
  let body = '';
  try { body = services.skills.get(skill.name, agent.id)?.body.trim() ?? ''; } catch { body = ''; }
  if (body && body.length <= WHOLE_CHARS) return `- ${skill.name} (skill): ${body.replace(/\s*\n\s*/g, ' ')}`;
  return `- ${skill.name} (skill) – ${excerpt(skill.description, DESCRIPTION_CHARS)} (skills.load ${skill.name} before that kind of work)`;
}

function noteLine(item: KnowledgeItem, now: number, zone: string | undefined): string {
  const saved = savedText(item.recordedAt, now, zone);
  if (item.body.length <= WHOLE_CHARS) return `- ${item.title}: ${item.body.replace(/\s*\n\s*/g, ' ')} (${saved})`;
  return `- ${item.title} – ${excerpt(item.description || item.body, DESCRIPTION_CHARS)} (memory.read ${item.id.replace(/:/g, '/')}; ${saved})`;
}

/** The set's lines within ALWAYS_CHARS: a line that does not fit is left out, a smaller later one may still fit. */
export function alwaysLines(services: RuntimeServices, agent: Agent, set: AlwaysSet, zone: string | undefined): string[] {
  const now = services.clock.now();
  const lines: string[] = [];
  let used = 0;
  for (const line of [...set.skills.map((skill) => skillLine(services, agent, skill)), ...set.notes.map((item) => noteLine(item, now, zone))]) {
    if (used + line.length + 1 > ALWAYS_CHARS) continue;
    used += line.length + 1;
    lines.push(line);
  }
  return lines;
}
