// Avatars: agent identity (never a provider logo) and the human (a chat's image: chat-face.tsx ChatFace, B-050 K9).
// Palette index 0..5 maps to the Codex-like palette in styles/tokens.css (--av-<n>-bg/fg).
// Agents with generated initials are drawn from `agentLooks` (shared/text/avatar-looks.ts):
// free colors by creation order and a second letter when initials collide.
// B-041 §8 – humans and AI at first sight: people are round, agents a rounded square (`agent`,
// also for image and emoji avatars, base.css 30 %); the working ring is one for every shape (base.css
// `.avatar.working`: a calm ring inside the avatar's own box, in its shape – never a moving arc, which
// read as a stray bracket round a square, and never past the box), the status dot stays the callers'. AgentAvatar
// decides by id: an agent, else a person ('human', 'per_…', on a person's device 'owner') is round.
// Owns: avatar rendering incl. the working ring and the shape. Never: decides who is "working" –
// callers pass real activity only; never alters image or emoji avatars.

import { computed } from '@preact/signals';
import type { Avatar as AvatarModel } from '../../shared/model/org.ts';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { isHumanActor, OWNER_ALIAS } from '../../shared/model/people.ts';
import { distinctLooks } from '../../shared/text/avatar-looks.ts';
import { fileUrl } from './files.ts';
import { initials } from './format.ts';
import { agents, knownAgentMap, settings } from './store.ts';
import { peopleMap } from './people.ts';
import { selfIdentity } from './self-identity.ts';

/** Distinct look (text + palette color) of every agent with an initials avatar, by agent id. */
export const agentLooks = computed(() => distinctLooks(agents.value));

/** Stable palette index from an id (used when an avatar has no explicit color). */
export function paletteIndex(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 6;
}

export interface AvatarProps {
  name: string;
  avatar?: AvatarModel;
  seed?: string;
  size?: number;
  working?: boolean;
  /** An AI agent: drawn as a rounded square (people and chats stay round). */
  agent?: boolean;
  onClick?: (event: MouseEvent) => void;
  title?: string;
  class?: string;
}

export function Avatar(props: AvatarProps) {
  const size = props.size ?? 28;
  const avatar = props.avatar;
  // `seed` is the agent id for agent avatars (chat ids never match an agent).
  const look = props.seed && (!avatar || avatar.kind === 'initials') ? agentLooks.value.get(props.seed) : undefined;
  const color = look?.color ?? avatar?.color ?? paletteIndex(props.seed ?? props.name);
  const image = avatar?.kind === 'image' ? fileUrl(avatar.value).value : null;
  const content = image
    ? <img src={image} alt="" />
    : avatar?.kind === 'emoji' ? <span class="avatar-emoji">{avatar.value}</span>
    : <span>{look?.text ?? (avatar?.kind === 'initials' && avatar.value ? avatar.value.slice(0, 2) : initials(props.name))}</span>;
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(10, Math.round(size * 0.34))}px` };
  const className = `avatar${props.agent ? ' agent' : ''}${props.working ? ' working' : ''}${props.class ? ` ${props.class}` : ''}`;
  const label = props.title ?? (props.working ? `${props.name} is working` : props.name);
  if (props.onClick) {
    return (
      <button type="button" class={className} data-color={color} style={style} title={label} aria-label={label}
        onClick={(event) => { event.stopPropagation(); props.onClick!(event as unknown as MouseEvent); }}>
        {content}
      </button>
    );
  }
  return <span class={className} data-color={color} style={style} title={label} role="img" aria-label={label}>{content}</span>;
}

/** True when `id` names a human from this connection's side: the caller, a person, or (on a person's device) the CEO. */
function isHumanId(id: string): boolean {
  return isHumanActor(id) || id === OWNER_ALIAS;
}

/** Avatar of an agent by id (falls back to initials for removed agents); people's ids draw them round. */
export function AgentAvatar(props: { agentId: string; size?: number; working?: boolean; onClick?: (event: MouseEvent) => void }) {
  if (props.agentId === 'human') return <HumanAvatar size={props.size} onClick={props.onClick} />; // the caller: the profile button's identity
  const agent = knownAgentMap.value.get(props.agentId); // an archived agent keeps its name and picture in its old chats
  const person = agent ? undefined : peopleMap.value.get(props.agentId); // F-52: a person of the organisation
  if (person) return <Avatar name={person.name} avatar={person.avatar.value ? person.avatar : undefined} seed={props.agentId} size={props.size} onClick={props.onClick} class="human" />;
  if (!agent && isHumanId(props.agentId)) return <Avatar name="?" seed={props.agentId} size={props.size} onClick={props.onClick} class="human" />; // a person not loaded here
  return <Avatar name={agent?.name ?? '?'} avatar={agent?.avatar} seed={props.agentId} size={props.size} working={props.working} onClick={props.onClick} agent />;
}

/** The human's own bubble – the caller's identity (lib/self-identity.ts: profile photo, else initials). */
export function HumanAvatar(props: { size?: number; onClick?: (event: MouseEvent) => void }) {
  const self = selfIdentity(settings.value?.profile, peopleMap.value.get('human'));
  return <Avatar name={self.name} avatar={self.avatar} size={props.size} onClick={props.onClick} class="human" />;
}

/** Agent members of a chat (active only). */
export function agentMembers(chat: ConversationSummary): string[] {
  return chat.members.filter((member) => member.kind === 'agent' && !member.leftAt).map((member) => member.memberId);
}
