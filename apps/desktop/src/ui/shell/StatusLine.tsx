// The status line: a few small lines that lie over the top of the main zone (desktop) or under the phone's
// top row – never a reserved band, so nothing moves when one comes or goes. Shown: the connection, the
// emergency stop (Resume), running voice conversations (Open/Talk, End), realtime voice (Open, End),
// an agent using the computer (Watch – computer-notice.ts) and the toasts (lib/toasts.ts, newest first; most expire by
// themselves, those for to-dos, blockers and important messages stay until Open, Dismiss or until their chat or My day
// is open); other areas may register more
// (shell/notices.ts). At most three lines at once; the rest follow as earlier ones go.
// Owns: the line markup and the shell's own providers. Never: a notice's order (notices.ts).

import { useState } from 'preact/hooks';
import { rpc } from '../lib/rpc.ts';
import { activeConversationId, conversationMap, loadError, loaded } from '../lib/store.ts';
import { chatTitle } from '../lib/chat-face.tsx';
import { navigate } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { voicePhase, voiceSessions } from '../lib/shell-state.ts';
import { dismissToast, toasts } from '../lib/toasts.ts';
import { IconButton, Spinner } from '../lib/ui.tsx';
import { focusVoice, stopVoice } from '../chat/composer/voice.ts';
import { realtimeChat, stopRealtime } from '../chat/call/realtime-call.ts';
import { registerAiNotice } from '../onboarding/ai-notice.ts';
import { registerSetupNotice } from '../onboarding/setup-reminder.ts'; // AF-002: setup not finished, away from My day
import { registerSpeechPullNotice } from '../settings/speech-models.ts';
import { registerComputerNotice } from './computer-notice.ts';
import { NOTICE_PRIORITY, connectionNotice, registerNotice, visibleNotices } from './notices.ts';
import type { Notice, NoticeAction } from './notices.ts';
import { resumeAllWork, watchWorkStop, workStop } from './work-stop.ts';

const SHOWN = 3;

const chatName = (id: string): string => {
  const chat = conversationMap.value.get(id);
  return (chat && chatTitle(chat)) || 'Conversation';
};

function workStopNotice(): Notice | null {
  const state = workStop.value;
  if (!state?.stopped) return null;
  const actions: NoticeAction[] = can('work.resume') ? [{ label: 'Resume', run: () => resumeAllWork() }] : [];
  return { id: 'work-stop', tone: 'warn', text: state.stoppedFrom ? `Agent work stopped from ${state.stoppedFrom}` : 'Agent work stopped', actions, priority: NOTICE_PRIORITY.workStop };
}

function voiceNotices(): Notice[] {
  const sessions = voiceSessions.value;
  const several = sessions.length > 1;
  const open = activeConversationId.value;
  return sessions.map((session) => {
    const id = session.conversationId;
    const phase = voicePhase(session, several);
    const actions: NoticeAction[] = [];
    if (open !== id) actions.push({ label: 'Open', run: () => navigate({ view: 'chat', id }) });
    else if (session.listening === false) actions.push({ label: 'Talk', run: () => focusVoice(id) });
    actions.push({ label: 'End', run: () => stopVoice(id) });
    return { id: `voice:${id}`, tone: 'info', text: phase ? `${chatName(id)} · ${phase}` : chatName(id), actions, priority: NOTICE_PRIORITY.voice };
  });
}

function realtimeNotice(): Notice | null {
  const id = realtimeChat.value;
  if (!id) return null;
  const actions: NoticeAction[] = activeConversationId.value === id ? [] : [{ label: 'Open', run: () => navigate({ view: 'chat', id }) }];
  actions.push({ label: 'End', run: () => stopRealtime() });
  return { id: `realtime:${id}`, tone: 'info', text: `${chatName(id)} · realtime voice`, actions, priority: NOTICE_PRIORITY.call };
}

function toastNotices(): Notice[] {
  return [...toasts.value].reverse().map((toast): Notice => {
    const text = toast.body ? `${toast.title} · ${toast.body}` : toast.title;
    const chat = toast.conversationId;
    const open = chat ? () => navigate({ view: 'chat', id: chat }) : toast.taskId ? () => navigate({ view: 'day' }) : undefined;
    return {
      id: `toast-${toast.id}`, tone: toast.tone === 'error' ? 'error' : 'info', text, detail: text, priority: NOTICE_PRIORITY.toast,
      ...(open ? { actions: [{ label: 'Open', run: () => { open(); dismissToast(toast.id); } }] } : {}),
      onDismiss: () => dismissToast(toast.id),
    };
  });
}

/** Registers the shell's providers once per app start; returns the function that removes them. */
export function registerShellNotices(): () => void {
  watchWorkStop();
  const off = [
    registerNotice(() => connectionNotice({ status: rpc.status.value, loaded: loaded.value, loadError: loadError.value })),
    registerNotice(workStopNotice),
    registerNotice(voiceNotices),
    registerNotice(realtimeNotice),
    registerComputerNotice(),
    registerNotice(toastNotices),
    registerAiNotice(),
    registerSetupNotice(),
    registerSpeechPullNotice(),
  ];
  return () => off.forEach((unregister) => unregister());
}

function Action(props: { action: NoticeAction }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await props.action.run(); } finally { setBusy(false); }
  };
  return (
    <button type="button" class={`button ${props.action.primary ? 'primary' : 'secondary'} status-action`} title={props.action.title}
      disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>
      {props.action.label}
      {busy && <span class="status-action-spin"><Spinner size={12} /></span>}
    </button>
  );
}

export function StatusLine() {
  const list = visibleNotices.value.slice(0, SHOWN);
  return (
    <div class="status-host" role="status" aria-live="polite">
      {list.map((notice) => (
        <div key={notice.id} class={`status-note tone-${notice.tone}`} data-notice={notice.id}>
          <span class="status-text" title={notice.detail ?? notice.text}>{notice.text}</span>
          {notice.actions?.map((action) => <Action key={action.label} action={action} />)}
          {notice.onDismiss && <IconButton icon="x" label="Dismiss" size="small" iconSize={12} class="status-dismiss" onClick={notice.onDismiss} />}
        </div>
      ))}
    </div>
  );
}
