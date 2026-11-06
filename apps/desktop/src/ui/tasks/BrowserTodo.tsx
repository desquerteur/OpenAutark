// "Open browser" on a browser or social agent's confirm to-do (MP9, browser-todo.ts): opens that
// agent's own browser inline in the to-do, taken over by the person (opened at the to-do's
// address when it is closed), so a sign-in or a captcha is done right here. Hand back in the
// view gives it back and wakes the agent; answering, declining or finishing the to-do hands it
// back quietly (the answer wakes the agent already – a refused agent is still woken). When the
// browser closes meanwhile (idle), the inline view offers Open browser again at the same address.
// X02: phones get it too – a 'todo' phone over HTTPS may use that agent's browser while the to-do
// is open (the runtime checks it); on plain LAN http the to-do says quietly to open the HTTPS
// address instead (BrowserTodoNote).
// Owns: the button, the inline view, the HTTPS note and the quiet hand back. Never: answers the to-do itself.

import { useEffect, useState } from 'preact/hooks';
import type { TaskView } from '../../shared/model/tasks.ts';
import { HTTPS_NOTE, blockedNote, can, isOwner } from '../lib/session.ts';
import { agentMap } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';
import { BrowserLive, setTakeover } from '../workspace/BrowserLive.tsx';
import { browserSessions, refreshBrowserSessions, watchBrowserSessions } from '../workspace/BrowserTab.tsx';
import { browserTodoTarget, type BrowserTodoTarget } from './browser-todo.ts';

/** To-dos whose agent browser this window took over (handed back quietly once the to-do is settled). */
const takenFor = new Map<string, BrowserTodoTarget>();
/** X02: confirm to-dos a phone listed the browsers for (it sees an agent's browser only once its to-do exists). */
const listedFor = new Set<string>();

/** The browser "Open browser" opens for this to-do, if any (the owner, or a phone over HTTPS). */
export function useBrowserTodo(task: TaskView): BrowserTodoTarget | undefined {
  const allowed = task.widget?.type === 'confirm' && can('browser.takeover');
  useEffect(() => {
    if (!allowed) return;
    watchBrowserSessions();
    if (!isOwner() && !listedFor.has(task.id)) { listedFor.add(task.id); refreshBrowserSessions(); }
  }, [allowed, task.id]);
  if (!allowed) return undefined;
  // Once opened here the to-do keeps its browser, also after it closed (to open it again).
  return browserTodoTarget(task, agentMap.value, browserSessions.value) ?? takenFor.get(task.id);
}

/** A browser agent's confirm to-do on a phone over plain LAN http: where to do it instead of the button. */
export function BrowserTodoNote(props: { task: TaskView }) {
  const { task } = props;
  if (task.widget?.type !== 'confirm' || blockedNote('browser.takeover') !== HTTPS_NOTE) return null;
  const target = browserTodoTarget(task, agentMap.value, []);
  if (!target) return null;
  return <p class="todo-why">{HTTPS_NOTE} in {agentMap.value.get(target.agentId)?.name ?? 'the agent'}'s browser.</p>;
}

/** The to-do was answered, declined or finished: a takeover started from it ends without a second wake. */
export function handBackQuietly(taskId: string): void {
  const target = takenFor.get(taskId);
  if (!target) return;
  takenFor.delete(taskId);
  setTakeover(target, false, { wake: false }).catch(() => undefined);
}

export function BrowserTodo(props: { task: TaskView; target: BrowserTodoTarget }) {
  const [open, setOpen] = useState(() => takenFor.has(props.task.id));
  const [busy, setBusy] = useState(false);
  const openAt = props.target.url ?? 'about:blank';
  // The browser shown (and taken over) here is the one handed back quietly.
  useEffect(() => { if (open) takenFor.set(props.task.id, props.target); }, [open, props.task.id, props.target.agentId]);
  const start = async () => {
    setBusy(true);
    try {
      await setTakeover(props.target, true, { url: openAt });
      takenFor.set(props.task.id, props.target);
      setOpen(true);
    } catch (error) {
      toastError(error, 'Could not open the browser');
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <div class="todo-actions">
        <Button busy={busy} onClick={() => void start()} title="Use the agent's own browser here – it waits until you hand it back">Open browser</Button>
      </div>
    );
  }
  return <div style={{ margin: '8px 0' }}><BrowserLive target={props.target} openAt={openAt} /></div>;
}
