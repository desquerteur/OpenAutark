// Agent-programmed to-dos (F01): an ```app todo=true fence in an agent's message becomes an item
// on the person's "For you" list. The to-do's widget (shared/model/tasks.ts AppTodoWidget) points
// back at the fence by message id and parse index; the list renders the app from the message
// (ui/tasks/AppTodo.tsx) and the app's wf.complete(data) finishes it through blocks.answer.
// Used by the runtime (tasks/human.ts ingestApps, the receipt text) and every list renderer.
// Owns: the widget built from a fence's attributes, the guard that reads a stored widget as one,
// the frame attributes the list renders with, and the default title and reason.
// Never: copies the app's HTML into the task, validates it as a catalog block, or lets an app
// claim an approval or a credential (parse.ts AppReason).

import type { AppTodoWidget, HumanReason } from '../model/tasks.ts';
import { APP_PERMISSIONS, type AppAttrs } from './parse.ts';

/** Title of a mini-app to-do whose fence has no title="…". */
export const APP_TODO_TITLE = 'Mini-app';
/** Why a mini-app needs the person when the fence gives no reason=. */
export const APP_TODO_REASON: HumanReason = 'taste';

/** The widget stored for fence `index` of message `messageId`. */
export function appTodoWidget(messageId: string, index: number, attrs: AppAttrs): AppTodoWidget {
  return {
    type: 'app', messageId, index, permissions: [...attrs.permissions],
    ...(attrs.title ? { title: attrs.title } : {}),
    ...(attrs.expand ? { expand: true } : {}),
  };
}

/** The mini-app behind a stored widget, or undefined for catalog blocks (and anything malformed). */
export function appWidgetOf(widget: unknown): AppTodoWidget | undefined {
  const value = widget as Partial<AppTodoWidget> | null | undefined;
  if (!value || typeof value !== 'object' || value.type !== 'app') return undefined;
  if (typeof value.messageId !== 'string' || !value.messageId) return undefined;
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0) return undefined;
  return {
    type: 'app', messageId: value.messageId, index: value.index,
    permissions: Array.isArray(value.permissions) ? value.permissions.filter((item): item is string => typeof item === 'string' && APP_PERMISSIONS.has(item)) : [],
    ...(typeof value.title === 'string' && value.title ? { title: value.title } : {}),
    ...(value.expand === true ? { expand: true } : {}),
  };
}

/** The attributes the list's frame renders with: always a to-do, so wf.complete finishes it. */
export function appFrameAttrs(widget: AppTodoWidget): AppAttrs {
  return {
    todo: true, expand: widget.expand === true, permissions: [...widget.permissions],
    ...(widget.title ? { title: widget.title } : {}),
  };
}
