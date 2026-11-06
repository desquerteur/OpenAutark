// Owns: remembering each hire's standard and refreshing untouched SYSTEM.md heads at runtime start; B-078: putting the
// standard on top of a SYSTEM.md that has none (an exact old shipped head is swapped; any other text stays below as the
// agent's own part, with one review wake so the agent clears an old copied standard out of it).
// Edited instructions stay in place and get one durable review per new default, on the agent's normal model route.
// B-072 (live run 04.11.2026: four reviews of whole raw files cost 200k tokens, one agent invented its creator): the
// review shows only what changed in the standard, filled in for that agent; nothing changed for it → no review.
// B-076: the standard is the whole standing text (agent-default with the team's rules in it, PromptTemplates.standardTemplate),
// so a change of the rules renews or offers like any other; renewing an untouched head also brings the agent's own part
// to today's form once (org/role-upgrade.ts: "## My role", an old shipped role text swapped, "## What I have here" added).
// Never: changes a role text the person or agent wrote, calls a model directly, or treats a review as permission to
// overwrite custom text.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/open-fs.ts';
import type { Db } from '../db/database.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { KvRepo } from '../store/kv.ts';
import { cleanTemplate, renderTemplate, standardRuleValues } from '../context/templates.ts';
import { promptUpdateReference, reviewPromptOverrides } from '../context/prompt-updates.ts';
import { canonical } from '../root/text-doc.ts';
import { standingRuleValues, withStandardHead } from './hire.ts';
import { loadPreviousBodies, modernRoleSuffix } from './role-upgrade.ts';
import { standardHead } from './standard-upgrade.ts';
import { hasWorkStandard, ROLE_LINE, splitAtHave } from './system-parts.ts';

const SHOWN_MAX = 4000;
/** The changed lines up to SHOWN_MAX characters, cut between lines, with how many more there are (the reference has all). */
export function shownChanges(lines: readonly string[]): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > SHOWN_MAX) break;
    out.push(line);
    used += line.length + 1;
  }
  const more = lines.length - out.length;
  return more ? `${out.join('\n')}\n… (${more} more changed line${more === 1 ? '' : 's'} – the whole new standard part is in the file named below)` : out.join('\n');
}

/** The standard part of a SYSTEM.md (above its role heading), canonical; the whole text when it has no role heading. */
const headOf = (text: string): string => canonical(text).split(ROLE_LINE, 1)[0].trim();

/** Today's agent templates; none when the org cannot list them (tests without resources). */
function safeTemplates(s: Pick<RuntimeServices, 'org'>): ReturnType<RuntimeServices['org']['templates']> {
  try { return s.org.templates(); } catch { return []; }
}

const NAMESPACE = 'agent-prompt-defaults';
interface SavedDefault { template: string; baseline?: string; offered?: string }
type UpdateServices = Pick<RuntimeServices, 'db' | 'clock' | 'paths' | 'org' | 'wakes' | 'log'>;

/** A hire already starts with the current standard; remember it before its first app update. */
export function rememberAgentDefault(db: Db, agentId: string, template: string, instructions: string, at: number): void {
  new KvRepo(db).set(NAMESPACE, agentId, { template: cleanTemplate(template), baseline: canonical(instructions) } satisfies SavedDefault, at);
}

/** The standard part (above the role heading) of a template, filled in for one agent – the team's rules included. */
const standardPart = (template: string, values: Readonly<Record<string, string>>): string => renderTemplate(template, values).split(ROLE_LINE, 1)[0].trim();

/** The lines only in `before` (−) and only in `after` (+), in order (a longest-common-subsequence diff of non-empty lines). */
export function lineChanges(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const b = after.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  return { removed, added };
}

/** After the file reconcile, once per app start. Archived custom agents get their request when restored. `standing`: the values
 * every agent's standard is rendered with (the owner's name) – the review shows the standard filled in for that agent. */
export function refreshAgentPrompts(s: UpdateServices, template: string, render: (values: Readonly<Record<string, string>>) => string, agentId?: string, standing: Readonly<Record<string, string>> = {}): void {
  const current = cleanTemplate(template);
  if (!current) return;
  const revision = createHash('sha256').update(current).digest('hex');
  const saved = new KvRepo(s.db);
  let shipped: { templates: ReturnType<UpdateServices['org']['templates']>; previous: Record<string, string[]> } | undefined;
  const loadShipped = () => (shipped ??= { templates: safeTemplates(s), previous: loadPreviousBodies(s.paths.resources ? path.join(s.paths.resources, 'agents') : undefined) });
  const roleTemplates = () => loadShipped().templates;
  const previousBodies = () => loadShipped().previous;
  for (const agent of s.org.list({ includeArchived: true })) {
    if (agentId && agent.id !== agentId) continue;
    try {
      const previous = saved.get<SavedDefault>(NAMESPACE, agent.id);
      const templates = [previous?.template ?? '', current].filter(Boolean);
      const renew = (instructions: string): string | undefined => {
        const head = standardHead(instructions, templates);
        if (!head) return undefined;
        const rendered = render({ creator: head.creator, role: '', agent_name: agent.name }).trim();
        if (!rendered || !ROLE_LINE.test(rendered)) return undefined;
        const beforeRole = rendered.split(ROLE_LINE, 1)[0].trim();
        const suffix = modernRoleSuffix(head.suffix, { template: agent.template, templates: roleTemplates(), previous: previousBodies(), have: splitAtHave(rendered).tail });
        return `${beforeRole}\n\n${suffix}`;
      };
      // B-076 review fix: "edited" means the standard part (above the role heading) changed since the last record – an
      // agent that fits its own role or "What I have here" keeps following the team's standard, as its preface says.
      const next = previous?.baseline !== undefined && headOf(agent.instructions) !== headOf(previous.baseline) ? undefined : renew(agent.instructions);
      if (next !== undefined) {
        if (next !== agent.instructions) {
          s.org.update(agent.id, { instructions: next }, { by: HUMAN_ID, reason: 'The app renewed the unchanged standard part of SYSTEM.md.' });
        }
        rememberAgentDefault(s.db, agent.id, current, next, s.clock.now());
        continue;
      }
      // B-078: a SYSTEM.md without the team's "# How I work" at all (an own text, an old copied head) gets today's
      // standard on top – the standard head is always there. A head that is exactly an old shipped standard is swapped
      // (renew); any other old text stays whole under "## My role" and I get one review wake, because it may hold an
      // older standard that contradicts today's (live 06.11.: an approval-era copy behind the permission requests).
      const creator = agent.createdBy === HUMAN_ID ? '' : s.org.get(agent.createdBy)?.name ?? '';
      const standard = render({ creator, role: agent.role, agent_name: agent.name });
      const missing = agent.archivedAt === undefined && withStandardHead(agent.instructions, standard) !== agent.instructions;
      const swapped = missing ? renew(agent.instructions) : undefined;
      const repaired = !missing ? agent.instructions : swapped !== undefined && hasWorkStandard(swapped, standard) ? swapped : withStandardHead(agent.instructions, standard);
      if (repaired !== agent.instructions) {
        s.org.update(agent.id, { instructions: repaired }, { by: HUMAN_ID, reason: 'The app put the team\'s standard back on top of SYSTEM.md.' });
        s.db.tx(() => {
          rememberAgentDefault(s.db, agent.id, current, repaired, s.clock.now());
          if (repaired === swapped) return;
          s.wakes.wake({
            agentId: agent.id, reason: 'review', coalesceKey: `system-prompt-repair:${agent.id}`,
            origin: { source: 'system-prompt', label: 'System prompt repair' },
            note: [
              'My SYSTEM.md had lost the team\'s standard "How I work"; the app put today\'s standard back on top, and my whole earlier text now stands under "## My role".',
              'That earlier text may hold an older standard of its own (an old "# Standing instructions", a copied "## How I work", a translated copy) that says something other than today\'s. I clean my own part: I keep my role, my agreements and what I have here, and drop what is an old copy of the standard.',
              'agents.update with my id and instructions (my own part from "## My role" on) saves it; tools.find and tools.call reach it when it is not in the current tool list. I report briefly what I changed.',
            ].join('\n'),
          });
        });
        continue;
      }
      if (agent.archivedAt !== undefined || previous?.template === current || previous?.offered === revision) continue;
      const values = { ...standing, creator: agent.createdBy === HUMAN_ID ? '' : s.org.get(agent.createdBy)?.name ?? '', role: '', agent_name: agent.name };
      const fresh = standardPart(current, values);
      const changes = previous?.template ? lineChanges(standardPart(previous.template, values), fresh) : undefined;
      const baseline = previous?.baseline === undefined ? undefined : renew(previous.baseline) ?? previous.baseline;
      if (changes && !changes.removed.length && !changes.added.length) { // filled in, this agent's standard did not change
        saved.set(NAMESPACE, agent.id, { template: current, baseline, offered: revision } satisfies SavedDefault, s.clock.now());
        continue;
      }
      const reference = promptUpdateReference(s.paths, 'agent-default', fresh);
      const shown = changes ? shownChanges([...changes.removed.map((line) => `- ${line}`), ...changes.added.map((line) => `+ ${line}`)]) : '';
      s.db.tx(() => {
        s.wakes.wake({
          agentId: agent.id, reason: 'review', coalesceKey: `system-prompt:${revision}`,
          origin: { source: 'system-prompt', label: 'System prompt update' },
          note: [
            'Autark ships a new standard system prompt. My SYSTEM.md has custom edits and was kept unchanged.',
            changes ? `What changed in its standard part, filled in for me (− old, + new):\n${shown}\nThe whole new standard part, filled in: ${reference}.` : `The new standard part, filled in for me: ${reference}.`,
            'I choose: replace its standard part, adapt my current instructions with it as a reference, or keep my version. When the change does not touch my own agreements, taking it over is enough.',
            'agents.update with my id and instructions saves SYSTEM.md; tools.find and tools.call reach it when it is not in the current tool list. I report briefly what I chose.',
          ].join('\n'),
        });
        saved.set(NAMESPACE, agent.id, { template: current, baseline, offered: revision } satisfies SavedDefault, s.clock.now());
      });
    } catch (error) {
      s.log.warn('agent system prompt update not applied or offered', { agentId: agent.id, error: String(error) });
    }
  }
}

/** Start after the seed exists and before dispatching; restoration checks an archived agent without a restart. */
export function startPromptUpdates(s: UpdateServices & Pick<RuntimeServices, 'bus' | 'prompts' | 'settings'>): () => void {
  const prompts = s.prompts;
  if (!prompts) return () => {};
  reviewPromptOverrides(s);
  prompts.invalidate();
  const standing = () => standardRuleValues(standingRuleValues(s.settings.get())); // the person's name, every tool named
  const render = (values: Readonly<Record<string, string>>) => renderTemplate(prompts.standardTemplate(), { ...standing(), ...values });
  refreshAgentPrompts(s, prompts.standardTemplate(), render, undefined, standing());
  const archived = new Set(s.org.list({ includeArchived: true }).filter((agent) => agent.archivedAt !== undefined).map((agent) => agent.id));
  return s.bus.on('agent.upserted', (agent) => {
    if (agent.archivedAt !== undefined) { archived.add(agent.id); return; }
    if (!archived.delete(agent.id)) return;
    refreshAgentPrompts(s, prompts.standardTemplate(), render, agent.id, standing());
  });
}
