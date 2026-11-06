// Slash commands typed into the composer: /task /model /important /silent /todo /feedback (/important and
// /silent set the level of the next message, or send their text at that level; a schedule is "Schedule…" in the Plus
// menu). Parsing is pure; execution calls the same RPCs as the menus. A command whose RPC this
// connection may not call (session.can) is neither offered nor parsed – the text then goes to the
// chat as written. The menus' level entries (sendMenuItems: the Plus menu and the Send button's right-click menu) do
// the same as /important and /silent, and none is ever greyed out (owner 04.11.2026): with nothing to send yet they set
// the draft's level (a second pick sets it back to normal, the tick shows it).
// Owns: the command list, their effects and the level entries. Never: free-text interpretation (agents do).

import type { MethodName } from '../../../shared/api/methods.ts';
import { newId } from '../../../shared/ids.ts';
import type { ConversationSummary, MessageLevel } from '../../../shared/model/chat.ts';
import { rpc } from '../../lib/rpc.ts';
import { can } from '../../lib/session.ts';
import { feedbackOpen } from '../../lib/shell-state.ts';
import { pushToast, toastError } from '../../lib/toasts.ts';
import type { MenuItem } from '../../lib/ui.tsx';

/** What the Send entries do (the Plus menu and the Send button's right-click menu share them). */
export interface SendActions {
  /** Sends the draft now at this level (in schedule mode: schedules it); undefined while there is nothing to send yet. */
  sendAs?: (level: MessageLevel) => void;
  /** The draft's level and how to set it (what a level entry does while there is nothing to send). */
  level: MessageLevel;
  setLevel: (level: MessageLevel) => void;
  /** Switches the composer into schedule mode. */
  schedule?: () => void;
  /** The composer is in schedule mode. */
  scheduling?: boolean;
}

/** Send as important / Send silently / Schedule… – a level entry sends, or with nothing to send sets the draft's level. */
export function sendMenuItems(actions: SendActions): MenuItem[] {
  const verb = actions.scheduling ? 'Schedule' : 'Send';
  const pick = (level: MessageLevel) => (actions.sendAs ? actions.sendAs(level) : actions.setLevel(actions.level === level ? 'normal' : level));
  return [
    { label: `${verb} as important`, description: 'Reaches agents at work right away', checked: actions.level === 'important', onSelect: () => pick('important') },
    { label: `${verb} silently`, description: 'No notification; wakes only @mentions', checked: actions.level === 'silent', onSelect: () => pick('silent') },
    ...(can('messages.schedule') ? [{ label: 'Schedule…', description: 'Later, or on repeat', checked: actions.scheduling, onSelect: () => actions.schedule?.() }] : []),
  ];
}

export interface SlashCommand {
  name: string;
  hint: string;
  /** The RPCs the command needs. */
  needs: MethodName[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'task', hint: 'Create a task', needs: ['tasks.create'] },
  { name: 'model', hint: 'Choose model', needs: ['chats.update'] },
  { name: 'important', hint: 'Mark as important', needs: ['messages.send'] },
  { name: 'silent', hint: 'Send without notifying', needs: ['messages.send'] },
  { name: 'todo', hint: 'Add to your to-do list', needs: ['todos.add'] },
  { name: 'feedback', hint: 'Report a bug or idea', needs: ['feedback.create'] }, // no "Send": a build without a sender saves only
];

/** The commands this connection may run. */
export function availableCommands(): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) => command.needs.every((method) => can(method)));
}

export function parseSlash(text: string): { name: string; arg: string } | null {
  const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match || !availableCommands().some((command) => command.name === match[1])) return null;
  return { name: match[1], arg: (match[2] ?? '').trim() };
}

/** Turns text into a task: first line = title, "- " lines = checklist steps, rest = notes. */
export async function createTaskFromText(conversationId: string, text: string): Promise<boolean> {
  const lines = text.split('\n');
  const title = lines[0].trim();
  if (!title) return false;
  const steps: string[] = [];
  const notes: string[] = [];
  for (const line of lines.slice(1)) {
    const step = /^\s*(?:[-*]|\d+[.)]|\[ \])\s+(.+)$/.exec(line);
    if (step) steps.push(step[1].trim());
    else notes.push(line);
  }
  try {
    await rpc.call('tasks.create', { conversationId, title, steps: steps.length ? steps : undefined, notes: notes.join('\n').trim() || undefined, clientId: newId('req') });
    return true;
  } catch (error) {
    toastError(error, 'Task could not be created');
    return false;
  }
}

export interface SlashContext {
  chat: ConversationSummary;
  openModelMenu: () => void;
  setLevel: (level: MessageLevel) => void;
  /** Sends the whole draft (files, secrets, reply – composer/send.ts) with `body` as its text; true when sent. */
  send: (body: string, options?: { level?: MessageLevel }) => Promise<boolean>;
}

/** Runs a slash command. Returns true when the composer should be cleared. */
export async function runSlash(command: { name: string; arg: string }, ctx: SlashContext): Promise<boolean> {
  const { chat } = ctx;
  const { arg } = command;
  switch (command.name) {
    case 'task':
      return arg ? createTaskFromText(chat.id, arg) : false;
    case 'model':
      ctx.openModelMenu();
      return true;
    case 'important':
    case 'silent':
      if (!arg) { ctx.setLevel(command.name); return true; }
      return ctx.send(arg, { level: command.name });
    case 'todo':
      if (!arg) return false;
      try {
        await rpc.call('todos.add', { text: arg, conversationId: chat.id });
        pushToast({ title: 'Added to your to-do list' }, 3000);
        return true;
      } catch (error) { toastError(error); return false; }
    case 'feedback':
      if (!arg) { feedbackOpen.value = { view: 'chat', conversationId: chat.id }; return true; }
      try {
        await rpc.call('feedback.create', { kind: 'idea', text: arg, view: 'chat', conversationId: chat.id });
        pushToast({ title: 'Feedback saved' }, 3000);
        return true;
      } catch (error) { toastError(error); return false; }
    default:
      return false;
  }
}
