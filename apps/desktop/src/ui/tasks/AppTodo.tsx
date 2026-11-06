// The expanded body of a mini-app to-do on My day's list (F01): the agent's ```app fence, rendered from its
// message by the chat's own AppFrame – sandbox, frame budget (a collapsed or answered item unmounts it and frees
// its slot) and the permission row, so a microphone app works in the list; its wf.complete answers through
// blocks.answer and the item leaves. Only one to-do is expanded at a time, so there is one copy of the app.
// Owns: this body. Never: renders the app's HTML itself or answers for the person.

import type { AppTodoWidget, TaskView } from '../../shared/model/tasks.ts';
import { appFrameAttrs } from '../../shared/blocks/app-todo.ts';
import { AppFrame } from '../blocks/AppFrame.tsx';

export function AppTodoBody(props: { task: TaskView; widget: AppTodoWidget }) {
  return <AppFrame messageId={props.widget.messageId} index={props.widget.index} attrs={appFrameAttrs(props.widget)} />;
}
