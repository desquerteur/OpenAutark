// The avatar part of agents.update (B-044 decision 22, split out of agents.ts): a colour 0–5, one emoji
// ('' = initials) or `fileId` – a portrait image for the agent itself or a report it manages. An image
// is taken only when the caller's OWN run made it (a Codex image_generation result attached to its answer
// in that run – lean agent threads keep that tool, owner 29.10.2026 – or a media.image
// result of its run), it is a PNG or JPEG of at most AVATAR_IMAGE_MAX bytes (B-059: a larger PNG is shrunk to
// 512 px with computer/png.ts shrinkPng and stored as a new file – the provenance check stays on the run's original; a
// larger JPEG or an unsupported PNG is still refused), and the current avatar is no photo the person chose. A photo
// counts as the person's when no run of that agent made it and no agent set it. An image an agent's run made may be replaced (by a new
// portrait, an emoji or initials); the person's photo is never changed by an agent. A new portrait writes one quiet
// line in the run's chat.
// Owns: these rules, the provenance lookups, shrinking an oversized PNG of the run, and the line. Never: generates
// images, reads image bytes other than that PNG, or sets an avatar itself (agents.update saves through OrgService).

import type { ToolContext } from '../types.ts';
import type { Agent } from '../../../shared/model/org.ts';
import type { Db } from '../../db/database.ts';
import { FILE_ID } from '../../org/avatar-files.ts';
import { initials } from '../../org/avatar.ts';
import { shrinkPng } from '../../computer/png.ts';

export type AvatarArgs = { color?: number; emoji?: string; fileId?: string };

export const AVATAR_IMAGE_MAX = 1024 * 1024;
/** B-059: the long edge an oversized PNG portrait is shrunk to (the skill asks for 512 px squares). */
const PORTRAIT_EDGE = 512;
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg']);
const PERSON_PHOTO = 'This agent has a photo the person chose; it stays.';

/** One emoji (with modifiers/joiners), nothing else; '' goes back to initials. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|‍|️)*$/u;

/**
 * Whether the agent's current image avatar is a photo the person chose: no run of the agent made it and no agent set
 * it (an agent's portrait – also a shrunk copy – leaves its quiet "New portrait" line, portraitLine).
 */
export function personPhoto(db: Pick<Db, 'get'>, agent: Agent): boolean {
  if (agent.avatar.kind !== 'image') return false;
  const value = agent.avatar.value;
  if (madeByRun(db, agent.id, value)) return false;
  return !FILE_ID.test(value) || db.get(
    `SELECT 1 AS hit FROM messages WHERE kind = 'status' AND author_kind = 'agent' AND instr(meta, '"avatar":"image"') > 0 AND instr(meta, ?) > 0 LIMIT 1`,
    [`"fileId":"${value}"`]) === undefined;
}

/** The file came from a run of `agentId`: a Codex image result attached to its answer, or a media.image result. */
export function madeByRun(db: Pick<Db, 'get'>, agentId: string, fileId: string): boolean {
  if (!FILE_ID.test(fileId)) return false;
  const engine = db.get(
    `SELECT 1 AS hit FROM messages m JOIN runs r ON r.id = m.run_id
     WHERE m.author_id = ? AND r.agent_id = ? AND m.attachments LIKE ?
       AND EXISTS (SELECT 1 FROM run_items i WHERE i.run_id = r.id AND i.kind = 'tool_call' AND i.name = 'image_generation')
     LIMIT 1`, [agentId, agentId, `%"fileId":"${fileId}"%`]);
  if (engine) return true;
  return db.get(
    `SELECT 1 AS hit FROM run_items i JOIN runs r ON r.id = i.run_id
     WHERE r.agent_id = ? AND i.kind = 'tool_result' AND i.name = 'media.image' AND i.data LIKE ? LIMIT 1`, [agentId, `%${fileId}%`]) !== undefined;
}

/**
 * B-059: an oversized PNG of the run shrunk to PORTRAIT_EDGE (computer/png.ts shrinkPng) and stored as a new file – its id,
 * or undefined when it cannot be (a JPEG, a PNG variant shrinkPng does not decode, still too large, any failure).
 */
async function shrunk(ctx: ToolContext, fileId: string): Promise<string | undefined> {
  try {
    const small = shrinkPng(await ctx.services.files.read(fileId), PORTRAIT_EDGE);
    if (small.scale === 1 || small.data.byteLength > AVATAR_IMAGE_MAX) return undefined;
    return (await ctx.services.files.put(small.data, 'portrait.png', 'image/png')).id;
  } catch (error) {
    ctx.services.log.debug('portrait not shrunk', { fileId, error: String(error) });
    return undefined;
  }
}

async function portrait(ctx: ToolContext, target: Agent, fileId: string, color: number | undefined): Promise<Agent['avatar'] | string> {
  if (!madeByRun(ctx.services.db, ctx.agent.id, fileId)) return 'avatar.fileId must be an image my own run made (media.image, or my engine\'s own image tool where it has one).';
  const file = ctx.services.files.get(fileId);
  if (!file || !IMAGE_TYPES.has(file.mime)) return 'The portrait must be a PNG or JPEG image.';
  let value = fileId;
  if (file.size > AVATAR_IMAGE_MAX) {
    const small = file.mime === 'image/png' ? await shrunk(ctx, fileId) : undefined;
    if (!small) return 'The portrait must be at most 1 MB and this one could not be shrunk (a JPEG, or a PNG the app cannot read). Generate a new, simpler square 512 px image and try again.';
    value = small;
  }
  return { kind: 'image', value, ...(color !== undefined ? { color } : {}) };
}

/** The new avatar for agents.update, or why it is refused. */
export async function avatarPatch(ctx: ToolContext, target: Agent, avatar: AvatarArgs): Promise<Agent['avatar'] | string> {
  if (personPhoto(ctx.services.db, target)) return PERSON_PHOTO;
  if (avatar.fileId !== undefined && avatar.emoji !== undefined) return 'Set either avatar.fileId or avatar.emoji, not both.';
  const color = avatar.color ?? target.avatar.color;
  if (avatar.fileId !== undefined) return portrait(ctx, target, avatar.fileId, color);
  if (avatar.emoji !== undefined && avatar.emoji !== '' && !EMOJI.test(avatar.emoji)) return 'avatar.emoji must be a single emoji.';
  if (avatar.emoji === '') return { kind: 'initials', value: initials(target.name), ...(color !== undefined ? { color } : {}) };
  if (avatar.emoji !== undefined) return { kind: 'emoji', value: avatar.emoji, ...(color !== undefined ? { color } : {}) };
  return { ...target.avatar, ...(color !== undefined ? { color } : {}) };
}

/** One quiet line in the run's chat after a new portrait (it also marks the image as an agent's, personPhoto). */
export function portraitLine(ctx: ToolContext, agent: Agent): void {
  const chatId = ctx.conversationId;
  if (!chatId || agent.avatar.kind !== 'image') return;
  try {
    ctx.services.chats.status(chatId, {
      type: 'note', text: `New portrait for ${agent.name}.`,
      details: { agentId: agent.id, avatar: 'image', fileId: agent.avatar.value },
    }, { authorId: ctx.agent.id });
  } catch (error) {
    ctx.services.log.debug('portrait line failed', { agentId: agent.id, error: String(error) });
  }
}
