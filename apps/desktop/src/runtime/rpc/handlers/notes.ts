// notes.get / notes.meta / notes.save: a chat's shared notes for the owner's window and phones ('chat' tier) and
// as person variants for people in their own chats. Last write wins (runtime/notes/store.ts); `baseVersion`
// is accepted from editors and not needed. The owner's changes are written as 'human', a person's under their id.
// Owns: these handlers and their parameter checks. Never: the store rules themselves.

import { HUMAN_ID } from '../../../shared/ids.ts';
import '../../../shared/api/methods-notes.ts'; // the method shapes (module augmentation)
import { NOTES_MAX_CHARS } from '../../../shared/model/notes.ts';
import { getNotes, notesMeta, openChat, personOpens, saveNotes, viewNotes } from '../../notes/store.ts';
import { caller } from '../../people/rpc-base.ts';
import { id, input, onlyKeys, optNum, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const CHAT = { capability: 'chat' } as const;

function chatOf(params: unknown): string {
  const o = input(params);
  onlyKeys(o, ['conversationId']);
  return id(o, 'conversationId');
}

function saveParams(params: unknown): { conversationId: string; text: string } {
  const o = input(params);
  onlyKeys(o, ['conversationId', 'text', 'baseVersion']);
  optNum(o, 'baseVersion', { min: 0 });
  return { conversationId: id(o, 'conversationId'), text: text(o, 'text', { max: NOTES_MAX_CHARS, allowEmpty: true, multiline: true }) };
}

export function register(table: HandlerTable): void {
  table.add('notes.get', (params, ctx) => { const chat = chatOf(params); openChat(ctx.services, chat); return getNotes(ctx.services, chat); }, CHAT);
  table.add('notes.meta', (params, ctx) => { const chat = chatOf(params); openChat(ctx.services, chat); return notesMeta(ctx.services, chat); }, CHAT);
  table.add('notes.save', (params, ctx) => {
    const p = saveParams(params);
    openChat(ctx.services, p.conversationId);
    return saveNotes(ctx.services, p.conversationId, p.text, HUMAN_ID);
  }, CHAT);

  // People of the organisation, in chats they are a member of.
  table.addPerson('notes.get', (params, ctx) => {
    const person = caller(ctx);
    const chat = chatOf(params);
    personOpens(ctx.services, person.id, chat);
    return viewNotes(person.id, getNotes(ctx.services, chat));
  });
  table.addPerson('notes.meta', (params, ctx) => {
    const person = caller(ctx);
    const chat = chatOf(params);
    personOpens(ctx.services, person.id, chat);
    return viewNotes(person.id, notesMeta(ctx.services, chat));
  });
  table.addPerson('notes.save', (params, ctx) => {
    const person = caller(ctx);
    const p = saveParams(params);
    personOpens(ctx.services, person.id, p.conversationId);
    return viewNotes(person.id, saveNotes(ctx.services, p.conversationId, p.text, person.id));
  });
}
