// Composition (AF-007): one SkillLinks per runtime, made when first asked for (the previews live in it) – the global
// fetch, the skill library's folders, the blob store for uploaded ZIPs, the active agents and their home projects. After an
// install or update the library reads again, 'skills.changed' tells every window, the knowledge catalog syncs again and
// the home projects' skill lists are read again (agent-core/home.ts caches them).
// Owns: this wiring. Never: behaviour (skills/links/*).

import type { RuntimeServices } from '../contracts.ts';
import '../contracts/agent-core.ts';
import { catalogChanged } from '../knowledge/catalog.ts';
import { SkillLinks } from '../skills/links/service.ts';

const made = new WeakMap<RuntimeServices, SkillLinks>();

export function skillLinksOf(s: RuntimeServices): SkillLinks {
  const known = made.get(s);
  if (known) return known;
  const links = new SkillLinks({
    fetch: (url, init) => fetch(url, init),
    clock: s.clock,
    skills: s.skills,
    files: s.files,
    agents: () => s.org.list(), // archived agents are left out by list()
    home: (agentId) => { try { return s.agentCore?.homes.usable(agentId); } catch { return undefined; } },
    changed: ({ name, target }) => {
      (s.skills as { invalidate?(): void }).invalidate?.();
      if (target.kind === 'project') for (const agent of s.org.list()) s.agentCore?.homes.forget(agent.id);
      try { catalogChanged(s); } catch { /* no catalog in this runtime */ }
      s.bus.emit('skills.changed', { name });
    },
  });
  made.set(s, links);
  return links;
}
