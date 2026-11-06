// Secret metadata as agents see it (owner 29.10.2026: a catalog like a skill – id, name, description, route, tags, the
// site it was saved from and the handle; never a value): the catalog entries, their searchable text, one catalog line
// and the chat attachment lines. Every entry is for every agent.
// Owns: these projections. Never: reads ciphertext, decrypts a value, or treats a description as a permission.
import type { SecretGroup, SecretInfo } from '../../shared/model/security.ts';
import type { RuntimeServices } from '../contracts.ts';

type Searchable = Pick<SecretInfo, 'label' | 'description' | 'tags' | 'source'> & { route?: string };

/** The text a search compares: name, description, route, tags and the site it was saved from. */
export const secretMetadata = (info: Searchable): string =>
  [info.label, info.description ?? '', [info.route ?? '', ...(info.tags ?? []), info.source ?? ''].filter(Boolean).join(' ')].join('\n').trim();

/** One catalog entry as a line (like a skill index line): the handle, name, route, description, tags and source – never a value. */
export function catalogLine(entry: Pick<SecretInfo | SecretGroup, 'id' | 'label' | 'description' | 'route' | 'tags' | 'source'>, handles?: string): string {
  const extra = [entry.tags?.length ? `tags: ${entry.tags.join('; ')}` : '', entry.source ? `saved from ${entry.source}` : ''].filter(Boolean).join(', ');
  const purpose = entry.description?.replace(/\s+/g, ' ').trim();
  return `secret://${entry.id} "${entry.label}" (route ${entry.route ?? 'notes'})${purpose ? ` – ${purpose.slice(0, 240)}` : ''}${extra ? ` [${extra}]` : ''}${handles ? ` fields: ${handles}` : ''}`;
}

/** A catalog entry as agents find it: a single secret, or a group with its fields' handles. */
export interface CatalogEntry { id: string; label: string; description?: string; route: string; tags?: string[]; source?: string; handles?: string }

/** Every catalog entry (single secrets and groups), metadata only. */
export function catalogEntries(services: Pick<RuntimeServices, 'secrets'>): CatalogEntry[] {
  const all = services.secrets.list();
  let groups: SecretGroup[] = [];
  try { groups = services.secrets.groups(); } catch { groups = []; }
  return [
    ...all.filter((info) => !info.group).map((info) => ({ id: info.id, label: info.label, description: info.description, route: info.route ?? 'notes', tags: info.tags, source: info.source })),
    ...groups.map((group) => ({
      id: group.id, label: group.label, description: group.description, route: group.route ?? 'notes', tags: group.tags, source: group.source,
      handles: all.filter((info) => info.group?.id === group.id).map((info) => `${info.field ?? 'field'} secret://${info.id}`).join(', '),
    })),
  ];
}

/** The chat attachment lines of the secrets a message names (current metadata; ids that are gone are left out). */
export function secretLines(services: RuntimeServices, _agentId: string, ids: string[] | undefined): string[] {
  if (!ids?.length) return [];
  return services.secrets.list().filter((info) => ids.includes(info.id)).map((info) => `[Secret attachment secret://${info.id}] ${JSON.stringify({ id: info.id, name: info.label, purpose: info.description ?? '' })}\nSecret metadata is context for me. I use its handle anywhere – any site, command or host; its name and purpose are in the catalog file <data>/secrets/<route>.md.`);
}
