// Per-chat settings rules split from chat/service.ts (MM6, to make room there): the model/effort
// choice sent with a human message, the model tag it carries, and the settings cleaner (empty maps
// and undefined keys dropped).
// - Choice (B-050 K6): a message's `model` is a recommendation – it becomes the addressed agents'
//   soft hint (settings.modelHints) and drops their pin; only `pin: true` pins it (settings.models,
//   the hint goes); 'auto' clears pin and hint. `effort` sets settings.efforts ('auto' clears). The
//   addressed agents: the message's @mentioned agents (a reply mentions the agent replied to), else
//   the lead, else the first agent – as the composer's chip (ui/chat/composer/target.ts).
// - Tag (K6): a human text message carries the first addressed agent's current choice as
//   meta.modelHint – the pin ({pinned: true}), else the hint, with the chat's effort; Auto = no tag.
// SG: a pin never revives an old hint and a hint never keeps an old pin.
// Owns: those rules. Never: writes rows (the chat service persists the conversation and the message).

import type { Conversation, ConversationSettings, Member, Message, ModelTag, SendMessageInput } from '../../shared/model/chat.ts';

/** The agents a message addresses (see the header), first the one its tag is for; [] in a chat without agents. */
export function addressedAgents(message: Pick<Message, 'mentions'>, members: readonly Member[]): string[] {
  const agents = members.filter(m => m.kind === 'agent' && m.leftAt === undefined).map(m => m.memberId);
  const targets = message.mentions.filter(id => agents.includes(id));
  if (targets.length) return targets;
  const lead = members.find(m => m.role === 'lead' && m.kind === 'agent' && m.leftAt === undefined)?.memberId ?? agents[0];
  return lead ? [lead] : [];
}

/** K6: the agent's current choice in the chat as a message tag – the pin, else the hint; undefined in Auto. */
export function modelTag(settings: ConversationSettings, agentId: string | undefined): ModelTag | undefined {
  if (!agentId) return undefined;
  const pin = settings.models?.[agentId];
  const hint = settings.modelHints?.[agentId];
  const modelId = pin && pin !== 'auto' ? pin : hint && hint !== 'auto' ? hint : undefined;
  if (!modelId) return undefined;
  const effort = settings.efforts?.[agentId];
  return { modelId, ...(effort && effort !== 'auto' ? { effort } : {}), ...(modelId === pin ? { pinned: true } : {}) };
}

/** Applies the input's model/effort to `conversation.settings`; false when it carried neither. */
export function applyStickyModel(conversation: Conversation, message: Message, input: Pick<SendMessageInput, 'model' | 'effort' | 'pin'>, members: Member[]): boolean {
  if (input.model === undefined && input.effort === undefined) return false;
  const models = { ...(conversation.settings.models ?? {}) };
  const hints = { ...(conversation.settings.modelHints ?? {}) };
  const efforts = { ...(conversation.settings.efforts ?? {}) };
  for (const id of addressedAgents(message, members)) {
    if (input.model !== undefined) {
      delete models[id];
      delete hints[id];
      if (input.model !== 'auto') (input.pin === true ? models : hints)[id] = input.model;
    }
    if (input.effort !== undefined) { if (input.effort === 'auto') delete efforts[id]; else efforts[id] = input.effort; }
  }
  conversation.settings = cleanSettings({ ...conversation.settings, models, modelHints: hints, efforts });
  conversation.updatedAt = message.createdAt;
  return true;
}

export function cleanSettings(settings: ConversationSettings): ConversationSettings {
  const out: ConversationSettings = { ...settings };
  if (out.models && !Object.keys(out.models).length) delete out.models;
  if (out.efforts && !Object.keys(out.efforts).length) delete out.efforts;
  if (out.modelHints && !Object.keys(out.modelHints).length) delete out.modelHints;
  for (const key of Object.keys(out) as Array<keyof ConversationSettings>) if (out[key] === undefined) delete out[key];
  return out;
}
