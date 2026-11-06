// The chat folder command of the wf terminal client (B-050 K8): `wf export <chat…> [--dir <folder>]`
// writes chats as readable folders with their files (chats.export). Chats are named by id or name like
// everywhere in wf; a folder is taken relative to the current directory.
// Owns: what this command calls and prints. Never: reads or writes the folders itself (the
// runtime does, as the owner, on this PC).

import path from 'node:path';
import type { ConversationSummary } from '../../shared/model/chat.ts';
import { text } from './args.ts';
import type { Command } from './commands.ts';
import { namesOf } from './format.ts';
import { loadAgents, pickChat } from './resolve.ts';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export const exportCommand: Command = {
  usage: 'export <chat…> [--dir <folder>]',
  summary: 'Write chats as readable folders (chat.json, messages/<month>.jsonl) with their files into --dir, else into a new folder under the app\'s exports.',
  options: ['dir'],
  arity: [1, 500],
  async run(ctx) {
    const [chats, agents] = await Promise.all([ctx.rpc.call('chats.list', { includeHidden: true }) as Promise<ConversationSummary[]>, loadAgents(ctx.rpc)]);
    const name = namesOf(agents);
    const conversationIds = [...new Set(ctx.parsed.args.map((ref) => pickChat(chats, ref, name).id))];
    const dir = text(ctx.parsed, 'dir');
    const result = await ctx.rpc.call('chats.export', { conversationIds, ...(dir ? { dir: path.resolve(dir) } : {}) }) as { dir: string; chats: number; messages: number; files: number };
    if (ctx.json) ctx.out.json(result);
    else ctx.out.line(`Exported ${plural(result.chats, 'chat')}, ${plural(result.messages, 'message')} and ${plural(result.files, 'file')} to ${result.dir}`);
  },
};
