// A chat's face as the caller sees it (B-050 K2/K9): a custom image or emoji, else its partner (an agent
// square, a person round – AgentAvatar), else the initials of its title. The names, the partner and the
// second line are lib/chat-naming.ts (plain data; re-exported here for the views that draw a face too).
// Owns: the chat's picture. Never: stores or derives stored titles (the runtime does).

import type { ConversationSummary } from '../../shared/model/chat.ts';
import { AgentAvatar, Avatar } from './avatar.tsx';
import { chatPartner, chatTitle } from './chat-naming.ts';

export { chatPartner, chatSubtitle, chatTitle, memberName, partnerPage } from './chat-naming.ts';

/** The chat's picture: custom image or emoji, else its partner's avatar, else its title's initials; with `onClick` a button. */
export function ChatFace(props: { chat: ConversationSummary; size?: number; onClick?: (event: MouseEvent) => void }) {
  const { chat } = props;
  const working = chat.working.length > 0;
  const image = chat.settings.image;
  if (image) {
    const isFile = /^[0-9a-f]{64}$/.test(image);
    return <Avatar name={chatTitle(chat)} avatar={isFile ? { kind: 'image', value: image } : { kind: 'emoji', value: image }} seed={chat.id} size={props.size} working={working} onClick={props.onClick} />;
  }
  const partner = chatPartner(chat);
  if (partner) return <AgentAvatar agentId={partner.memberId} size={props.size} working={working} onClick={props.onClick} />;
  return <Avatar name={chatTitle(chat)} seed={chat.id} size={props.size} working={working} onClick={props.onClick} />;
}
