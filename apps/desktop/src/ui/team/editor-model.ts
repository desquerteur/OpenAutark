// Agent editor rules (O6), pure: the draft the form starts from (name, role, avatar, instructions), the patch
// with only the changed fields, the avatar a draft stands for (generated initials follow the name; the look a
// new color gets among the other agents) and one-emoji input. Where it reports to, its space, team, mode, PC and
// voice are set by the manager or by asking the AI (agents.update).
// Owns: these rules (unit-tested in test/unit/ui/agent-editor.test.ts).
// Never: imports the store, rpc or the DOM – callers pass data in; never decides validity (the runtime
// validates every field again).

import type { Agent, Avatar } from '../../shared/model/org.ts';
import { avatarInitials, avatarPaletteIndex, distinctLooks, PALETTE_SIZE } from '../../shared/text/avatar-looks.ts';
import type { Look } from '../../shared/text/avatar-looks.ts';

export { PALETTE_SIZE };

/** What the form edits. */
export interface EditorDraft {
  name: string;
  role: string;
  instructions: string;
  /** The chosen avatar; for initials the letters are taken from the name when saving. */
  avatar: Avatar;
}

/** agents.update patch the editor sends: only changed fields. */
export interface EditorPatch {
  name?: string;
  role?: string;
  instructions?: string;
  avatar?: Avatar;
}

/** Quick picks of the emoji avatar (any other emoji can be typed or pasted). */
export const EMOJI_PICKS: readonly string[] = ['🤖', '🧠', '💼', '📊', '🎬', '✍️', '🔎', '🎨', '📣', '🛠️', '📅', '💡'];

const MAX_EMOJI_CHARS = 16; // what an exported agent file accepts (runtime org/avatar-files.ts)

function cleanName(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

export function draftOf(agent: Agent): EditorDraft {
  return {
    name: agent.name,
    role: agent.role,
    instructions: agent.instructions,
    avatar: { ...agent.avatar },
  };
}

/** The avatar a draft saves: initials from the (new) name, trimmed emoji, images without a color. */
export function draftAvatar(draft: Pick<EditorDraft, 'name' | 'avatar'>, fallbackName = ''): Avatar {
  const { avatar } = draft;
  if (avatar.kind === 'image') return { kind: 'image', value: avatar.value };
  const value = avatar.kind === 'initials' ? avatarInitials(cleanName(draft.name) || fallbackName) : avatar.value.trim();
  return avatar.color === undefined ? { kind: avatar.kind, value } : { kind: avatar.kind, value, color: avatar.color };
}

function sameAvatar(a: Avatar, b: Avatar): boolean {
  return a.kind === b.kind && a.value === b.value && (a.color ?? -1) === (b.color ?? -1);
}

/** Only what changed. A generated-initials avatar with the same color is left out on a rename: the runtime renews the letters itself and keeps the stored color. */
export function editorPatch(agent: Agent, draft: EditorDraft): EditorPatch {
  const patch: EditorPatch = {};
  const name = cleanName(draft.name);
  if (name && name !== agent.name) patch.name = name;
  const role = draft.role.trim();
  if (role !== agent.role) patch.role = role;
  if (draft.instructions !== agent.instructions) patch.instructions = draft.instructions;
  const avatar = draftAvatar(draft, agent.name);
  const lettersOnly = agent.avatar.kind === 'initials' && avatar.kind === 'initials' && (avatar.color ?? -1) === (agent.avatar.color ?? -1);
  if (!lettersOnly && !sameAvatar(avatar, agent.avatar)) patch.avatar = avatar;
  return patch;
}

export function hasChanges(patch: EditorPatch): boolean {
  return Object.keys(patch).length > 0;
}

/**
 * The look an initials avatar would get among the other agents (the same rules the avatars are
 * drawn with: a color equal to the id's hash color counts as "not chosen" and may give way to a
 * freer one). Undefined for emoji and image avatars.
 */
export function previewLook(agents: readonly Agent[], agentId: string, name: string, avatar: Avatar): Look | undefined {
  if (avatar.kind !== 'initials') return undefined;
  const self = agents.find((agent) => agent.id === agentId);
  const others = agents.filter((agent) => agent.id !== agentId && !agent.archivedAt);
  const draft = { id: agentId, name: cleanName(name) || self?.name || '?', avatar, createdAt: self?.createdAt };
  return distinctLooks([...others, draft]).get(agentId);
}

/** The color index an avatar shows (look first, then its own, then the id's hash color). */
export function shownColor(agentId: string, avatar: Avatar, look?: Look): number {
  return look?.color ?? avatar.color ?? avatarPaletteIndex(agentId);
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

/** The first emoji of typed or pasted text (one grapheme), or '' when the text starts with none. */
export function firstEmoji(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  let first = Array.from(trimmed)[0] ?? '';
  for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(trimmed)) { first = part.segment; break; }
  return PICTOGRAPHIC.test(first) && first.length <= MAX_EMOJI_CHARS ? first : '';
}
