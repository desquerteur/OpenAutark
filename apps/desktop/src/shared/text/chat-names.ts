// Display helpers for chats: derived titles, list previews, @mention parsing, and (B-050 K2) the
// title each viewer sees (displayTitle: a two-member room is named after the other member).
// Owns: pure string rules shared by runtime (stored previews/titles) and UI (rendering).
// Never: imports outside src/shared; never invents names (falls back to member names only).

import { foldText } from './normalize.ts';

/** Collapses whitespace and cuts to `max` characters (with an ellipsis when cut). */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : flat;
}

/**
 * Plain one-line preview of a message body: fenced blocks become a short label (their title
 * or type), markdown markers are dropped, the first non-empty line is used.
 */
export function previewText(body: string, attachments: Array<{ name: string }> = [], max = 120): string {
  const withoutFences = body.replace(/```(\w*)([^\n]*)\n([\s\S]*?)(```|$)/g, (_all, lang: string, info: string, inner: string) => {
    if (lang === 'ui') {
      const title = /"title"\s*:\s*"([^"]{1,60})"/.exec(inner)?.[1];
      const type = /"type"\s*:\s*"([a-z_]{1,20})"/.exec(inner)?.[1];
      return `\n[${title ?? type ?? 'ui'}]\n`;
    }
    if (lang === 'mermaid') return '\n[diagram]\n';
    if (lang === 'app') return `\n[${/title="([^"]{1,60})"/.exec(info)?.[1] ?? 'app'}]\n`;
    return `\n${inner.split('\n')[0] ?? ''}\n`;
  });
  const line = withoutFences
    .split(/\r?\n/)
    .map(part => part.replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|>\s?|\d+\.\s+)/, '').replace(/[*_`~]/g, '').trim())
    .find(Boolean);
  if (line) return excerpt(line, max);
  return excerpt(attachments.map(file => file.name).join(', '), max);
}

/** Title for an unnamed chat derived from its first human message. */
export function deriveTitle(body: string, max = 60): string {
  return previewText(body, [], max);
}

/**
 * Name shown for a chat: an explicit title wins; otherwise the agent members' names
 * (1:1 → that agent's name). Returns '' when nothing is known (the UI shows its own label).
 */
export function chatName(title: string, titleNamed: boolean, agentNames: string[]): string {
  if (titleNamed && title.trim()) return title.trim();
  if (title.trim()) return title.trim();
  return agentNames.filter(Boolean).join(', ');
}

/** B-050 K2: the other member of a two-member room seen by `viewerId` (one of the two); else undefined. */
export function counterpartId(active: ReadonlyArray<{ memberId: string }>, viewerId: string): string | undefined {
  if (active.length !== 2 || !active.some((member) => member.memberId === viewerId)) return undefined;
  return active.find((member) => member.memberId !== viewerId)?.memberId;
}

/** True when `title` only lists names of `names` ("Tom", "Ada, Tom" – the auto title of older chats, a seed named after its agent): it names no topic. */
export function onlyNames(title: string, names: readonly string[]): boolean {
  const parts = title.split(',').map((part) => part.trim());
  return Boolean(title.trim()) && parts.every((part) => part && names.includes(part));
}

/**
 * B-050 K2: the chat's title as `viewerId` sees it (`active`: its active members; `nameOf`: a
 * member's display name, undefined when unknown). The default 1:1 (settings.direct) is named by its
 * members only, and so is a two-member room whose title only lists their names (onlyNames – else an
 * agent would read its own name as the topic); the stored title is then the fallback when no name is known.
 * - Two members, the viewer one of them: the other's name, with " · title" when a title exists.
 * - Two members, the viewer not one of them: the title, else both names ("Mara & Tom").
 * - Any other room (also a default 1:1 others joined, K1): the title, else the names of the members
 *   other than the viewer.
 * Returns '' when nothing is known (the UI shows its own label).
 */
export function displayTitle(
  chat: { title: string; titleNamed: boolean; settings?: { direct?: boolean } },
  active: ReadonlyArray<{ memberId: string }>,
  viewerId: string,
  nameOf: (id: string) => string | undefined,
): string {
  const stored = chat.title.trim();
  const names = (ids: string[]) => ids.map((id) => nameOf(id)?.trim()).filter((name): name is string => Boolean(name));
  const ids = active.map((member) => member.memberId);
  const title = chat.settings?.direct || (ids.length === 2 && onlyNames(stored, names(ids))) ? '' : stored;
  if (active.length === 2) {
    const other = counterpartId(active, viewerId);
    if (other === undefined) return title || names(ids).join(' & ') || stored;
    const name = nameOf(other)?.trim() || '';
    if (!title) return name || stored;
    return name ? `${name} · ${title}` : title;
  }
  return title || names(ids.filter((id) => id !== viewerId)).join(', ') || stored;
}

/**
 * Finds `@Name` mentions in a body against candidate members (names may contain spaces).
 * Longest names are tried first so "@Anna Lena" beats "@Anna". Matching is folded
 * (case/diacritics-insensitive) and requires a word boundary after the name.
 */
export function findMentions(body: string, candidates: Array<{ id: string; name: string }>): string[] {
  if (!body.includes('@')) return [];
  const folded = foldText(body);
  const sorted = [...candidates].filter(c => c.name.trim()).sort((a, b) => b.name.length - a.name.length);
  const found = new Set<string>();
  let index = folded.indexOf('@');
  while (index >= 0) {
    const rest = folded.slice(index + 1);
    for (const candidate of sorted) {
      const name = foldText(candidate.name.trim());
      const next = rest.charAt(name.length);
      if (rest.startsWith(name) && (next === '' || !/[\p{L}\p{N}_]/u.test(next))) {
        found.add(candidate.id);
        break;
      }
    }
    index = folded.indexOf('@', index + 1);
  }
  return [...found];
}
