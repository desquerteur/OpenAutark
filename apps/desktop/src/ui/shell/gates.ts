// Which shell-wide entry points this connection may use (DEV4: a phone never sees a control that
// can only be refused – lib/session.ts can()): the command palette's actions, the new-chat
// hotkey and whether a chat route may render (a To-do-only phone that lands on #/chat/<id>, e.g.
// from an older notification, gets My day instead of a chat it may not read).
// Owns: these gates. Never: the controls themselves or what they do.

import { can, session } from '../lib/session.ts';

/** The palette's own actions (CommandPalette entry ids). */
export type PaletteActionId = 'a:new-chat' | 'a:new-task' | 'a:day' | 'a:sidebar' | 'a:feedback' | 'a:work-stop' | 'a:work-resume';

/** New chat (palette, mod+n): only where chats.create would be accepted. */
export function canStartChat(): boolean {
  return can('chats.create');
}

/** The palette actions this connection may use; 'New task in this chat' also needs an open chat, 'My day' its list, todos.list. */
export function paletteActions(chatId?: string | null): Set<PaletteActionId> {
  const ids: PaletteActionId[] = ['a:sidebar'];
  if (can('todos.list')) ids.push('a:day');
  if (canStartChat()) ids.push('a:new-chat');
  if (chatId && can('tasks.create')) ids.push('a:new-task');
  if (can('feedback.create')) ids.push('a:feedback');
  if (can('work.stop')) ids.push('a:work-stop'); // the emergency stop (shell/work-stop.ts)
  if (can('work.resume')) ids.push('a:work-resume');
  return new Set(ids);
}

/** False once the session says this connection may not read chats (shell/views.ts shows My day). */
export function chatRouteAllowed(): boolean {
  return !session.value || can('messages.list');
}
