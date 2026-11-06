// What the new-chat dialog's "Start chat" does (B-050 K9): exactly one member and no topic opens the
// pair's default 1:1 (chat/direct.ts); anything else creates a chat with the chosen agents and people and
// the topic as its title – without one it is named like every untitled chat: each viewer sees the other
// members' names (shared/text/chat-names.ts displayTitle) until the first message gives it a topic
// (runtime chat/service.ts deriveTitle). Repeated topic chats with the same member stay possible.
// Owns: that decision. Never: calls RPC or reads the store (the caller says which ids are agents).

export type NewChatPlan =
  | { kind: 'direct'; memberId: string }
  | { kind: 'create'; title?: string; agentIds: string[]; people: string[] };

export function newChatPlan(selected: readonly string[], topic: string, isAgent: (id: string) => boolean): NewChatPlan | null {
  if (!selected.length) return null;
  const title = topic.trim();
  if (selected.length === 1 && !title) return { kind: 'direct', memberId: selected[0] };
  return {
    kind: 'create', ...(title ? { title } : {}),
    agentIds: selected.filter((id) => isAgent(id)), people: selected.filter((id) => !isAgent(id)),
  };
}
