// The subconscious's own thoughts (B-078 D14, owner 06.11.2026: "dass es … sich Gedanken auch wirklich speichert. Muss
// nicht immer so schön sein, sondern kann auch so stichwortartig sein"): thought.keep appends keyword lines, each with its
// day, to the memory file agents/<id>/thoughts.md – a memory file like any other, so it is embedded and searched with the
// rest; the newest THOUGHTS_SHOWN lines open each run (flow.ts). The same thought is kept once; the file keeps the newest
// MAX_LINES lines. Also the main AI's stable prompt as the subconscious's first input (mainPrompt): who the agent is, what
// it works with and what it agreed – redacted, cut, the same text for the same agent and mode (its runs cache it).
// Owns: the thoughts file's form, the tool and the main prompt's cut. Never: keeps a secret value or lists memory into a context.

import type { RuntimeServices } from '../contracts.ts';
import type { Agent } from '../../shared/model/org.ts';
import type { RouteDecision } from '../../shared/model/providers.ts';
import { buildStable } from '../context/prompt-stable.ts';
import '../contracts/open-fs.ts';
import { dayText } from '../knowledge/age.ts';
import { profileZone } from '../context/time.ts';
import type { FlowRun, FlowTool } from './tools.ts';

export const THOUGHTS_SHOWN = 12;
const MAX_LINES = 200;
const LINE_CHARS = 200;
const LINES_PER_CALL = 5;
const MAIN_CHARS = 12_000;

export const thoughtsPath = (agentId: string): string => `agents/${agentId}/thoughts.md`;

function lines(text: string | undefined): string[] {
  return (text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- '));
}

/** The newest kept thoughts of this agent's subconscious ('' when there are none). */
export function recentThoughts(services: RuntimeServices, agentId: string, count = THOUGHTS_SHOWN): string {
  try { return lines(services.knowledge.memoryRead(thoughtsPath(agentId))?.text).slice(-count).join('\n'); } catch { return ''; }
}

export const thoughtTool: FlowTool = {
  name: 'thought.keep',
  args: '{text}',
  line: 'Keeps a thought of mine in keywords – what I noticed, suspect, want to look at again, how things hang together – in my own thoughts file, one line each (up to five). The newest open each of my runs, and the file is found by meaning like any memory. Rough is fine; a secret value stays out.',
  run(args, run: FlowRun) {
    const given = typeof args.text === 'string' ? args.text : Array.isArray(args.text) ? args.text.join('\n') : '';
    const redact = (value: string) => (run.services.secrets ? run.services.secrets.redact(value) : value);
    let day = '';
    try { day = dayText(run.services.clock.now(), profileZone(run.services)); } catch { day = ''; }
    const fresh = given.split('\n').map((line) => redact(line.replace(/^[-*\s]+/, '').replace(/\s+/g, ' ').trim()).slice(0, LINE_CHARS)).filter(Boolean).slice(0, LINES_PER_CALL);
    if (!fresh.length) return 'thought.keep needs a text.';
    const file = thoughtsPath(run.agent.id);
    const old = lines(run.services.knowledge.memoryRead(file)?.text);
    const known = new Set(old.map((line) => line.replace(/^- (\d{4}-\d{2}-\d{2}: )?/, '')));
    const added = fresh.filter((line) => !known.has(line));
    if (!added.length) return 'kept already';
    const next = [...old, ...added.map((line) => `- ${day ? `${day}: ` : ''}${line}`)].slice(-MAX_LINES);
    run.services.knowledge.memoryWrite({ path: file, title: `Thoughts of ${run.agent.name}'s subconscious`, text: next.join('\n'), description: 'My own keyword notes as the subconscious: what I noticed and want to look at again.', by: 'subconscious' });
    return `kept: ${added.length}`;
  },
};

/** The main AI's stable prompt for this agent and mode, redacted and cut ('' when there is no prompt set). */
export function mainPrompt(services: RuntimeServices, agent: Agent, modeKey: string): string {
  const templates = services.prompts;
  if (!templates) return '';
  try {
    const mode = services.modes.get(modeKey);
    const route: RouteDecision = { modelId: '', engine: 'compatible', accountId: '', effort: 'low', category: 'chat', reason: 'subconscious', by: 'rules', alternatives: [] };
    const text = buildStable(services, templates, { agent, mode, route });
    const clean = services.secrets ? services.secrets.redact(text) : text;
    return clean.length > MAIN_CHARS ? `${clean.slice(0, MAIN_CHARS).trimEnd()}\n[… cut]` : clean;
  } catch {
    return '';
  }
}
