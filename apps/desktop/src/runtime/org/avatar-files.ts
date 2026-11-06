// Agent avatar rules beyond the field shape (O6): an image avatar names a stored file by its id,
// initials and emoji stay short enough to travel in an agent file (portability/agent-file.ts
// reads at most 16 characters), and the image file ids agents use are references – archived
// agents included, since they can be restored – so blob clean-up keeps them.
// Owns: these checks and the reference list. Never: reads the blob store (the RPC handler checks
// that an uploaded image exists) or changes an avatar.

import { WorkforceError } from '../../shared/errors.ts';
import type { Agent, Avatar } from '../../shared/model/org.ts';

/** Blob ids are sha256 hex (files/store.ts). */
export const FILE_ID = /^[a-f0-9]{64}$/;
/** Longest initials/emoji text an exported agent file accepts again. */
export const AVATAR_TEXT_MAX = 16;

/** Throws a user-safe bad_request for an avatar the org must not store; returns it otherwise. */
export function checkAvatar(avatar: Avatar): Avatar {
  if (avatar.kind === 'image') {
    if (!FILE_ID.test(avatar.value)) throw new WorkforceError('bad_request', 'Choose an uploaded image for the avatar.', { details: { field: 'avatar' } });
    return avatar;
  }
  const text = avatar.value.trim();
  if (!text || text.length > AVATAR_TEXT_MAX || /\s/u.test(text)) {
    throw new WorkforceError('bad_request', avatar.kind === 'emoji' ? 'Choose one emoji for the avatar.' : 'Use one or two letters for the avatar.', { details: { field: 'avatar' } });
  }
  return { ...avatar, value: text };
}

/** Distinct file ids of image avatars (pass archived agents too). */
export function avatarFiles(agents: readonly Pick<Agent, 'avatar'>[]): string[] {
  const ids = new Set<string>();
  for (const agent of agents) if (agent.avatar.kind === 'image' && FILE_ID.test(agent.avatar.value)) ids.add(agent.avatar.value);
  return [...ids].sort();
}
