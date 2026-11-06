// Owns: following shipped prompt revisions for global overrides and one durable review request per edited default.
// Never: overwrites customized prompts, calls a model directly, or puts custom text or secret values in references.

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Paths, RuntimeServices } from '../contracts.ts';
import { readText, writeAtomic } from '../root/text-doc.ts';
import { KvRepo } from '../store/kv.ts';
import { cleanTemplate, OVERRIDABLE, OVERRIDE_MAX_BYTES, type PromptName } from './templates.ts';

type Services = Pick<RuntimeServices, 'db' | 'clock' | 'paths' | 'org' | 'wakes' | 'log'>;
interface DefaultState { text: string; offered?: string }
const NS = 'prompt-defaults';
const revision = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Keeps the full shipped text at a stable readable path, outside the active prompt overrides. */
export function promptUpdateReference(paths: Pick<Paths, 'data'>, name: PromptName, text: string): string {
  const cleaned = cleanTemplate(text);
  const file = path.join(paths.data, 'prompts', 'updates', `${name}-${revision(cleaned)}.md`);
  writeAtomic(file, `${cleaned}\n`);
  return file;
}

/** Runtime start: ordinary defaults follow the release; edited global prompts go to the team's manager for review. */
export function reviewPromptOverrides(s: Services): void {
  const state = new KvRepo(s.db);
  for (const name of OVERRIDABLE) {
    try {
      const shipped = readText(path.join(s.paths.resources, 'prompts', `${name}.md`), { maxBytes: OVERRIDE_MAX_BYTES });
      if (shipped.kind === 'missing') continue;
      if (shipped.kind !== 'ok') throw new Error(`Shipped prompt is ${shipped.problem}.`);
      const text = cleanTemplate(shipped.text);
      if (!text) continue;
      const previous = state.get<DefaultState>(NS, name);
      const ownFile = path.join(s.paths.data, 'prompts', `${name}.md`);
      const own = readText(ownFile, { maxBytes: OVERRIDE_MAX_BYTES });
      if (own.kind === 'problem') throw new Error(`Own prompt is ${own.problem}.`);
      const custom = own.kind === 'ok' ? cleanTemplate(own.text) : '';
      if (!custom || custom === text || custom === previous?.text) {
        // An untouched copy of an older shipped file is still a default, even when its comments or line ends differ.
        if (custom && custom !== text) writeAtomic(ownFile, `${text}\n`);
        state.set(NS, name, { text, ...(previous?.offered ? { offered: previous.offered } : {}) }, s.clock.now());
        continue;
      }
      const hash = revision(text);
      // An edit made against the already-observed release is intentional, not a new default to review.
      if (previous?.text === text || previous?.offered === hash) continue;
      const active = s.org.list().filter((agent) => agent.archivedAt === undefined);
      const reviewer = active.find((agent) => agent.template === 'manager') ?? active.find((agent) => !agent.managerId) ?? active[0];
      if (!reviewer) continue; // Without a recipient nothing was offered; retry at the next runtime start.
      const reference = promptUpdateReference(s.paths, name, text);
      const note = [
        `Autark has a new default system prompt: ${name}. My team's version was customized and has been kept unchanged.`,
        `I review it with my current configured model: I read the complete current file at ${ownFile} and the new default at ${reference}.`,
        'I choose whether to replace the custom file with the new default, adapt the current version using it as a reference while preserving custom agreements, or keep the current version. I make the useful change directly and briefly record my decision.',
        'tools.find / tools.call find any tools I need.',
      ].join('\n');
      s.db.tx(() => {
        s.wakes.wake({
          agentId: reviewer.id, reason: 'review', note,
          coalesceKey: `prompt-update:${name}:${hash}`,
          origin: { source: `system-prompt:${name}`, label: `System prompt update: ${name}` },
        });
        state.set(NS, name, { text, offered: hash }, s.clock.now());
      });
    } catch (error) {
      s.log.warn('system prompt update not reviewed', { name, error: String(error) });
    }
  }
}
