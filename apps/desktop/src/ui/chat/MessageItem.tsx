// One message. Agent: byline (avatar + name → agent view), body, small time below. The caller's own words:
// right-aligned bubble without a name. Another human's words (a colleague) sit on the left like an agent's,
// with name and round avatar (→ their page). Task messages render through TaskMessage; quiet status lines
// through StatusGroup (collapsible bursts). Failed/stopped messages show their short error and Retry.
// The meta row every message reserves holds the markers (important, silent, Ultra, scheduled, voice, from a
// messenger), the model tag (model-tag-view.ts), the time and "edited"/"imported" – nothing moves on hover.
// An agent answer from a run gets the quiet "Worked … · N steps" line above its body (RunDisclosure); a run's
// answer still being written renders in the live block at the bottom (WorkingMessage.tsx PendingWork; B-075: from its row).
// Right-click (long press) opens the message's menu (MessageActions.tsx: Reply, Copy, Edit, Delete); Edit
// swaps the body for the inline editor. A reply shows its quote line above the body (ReplyQuote). B-078: a message with
// a thread shows one quiet line under it ("3 replies · Mara", threads.ts) that opens or closes the thread in the side panel.
// Owns: message chrome. Never: renders untrusted HTML itself (MessageBody sanitizes).

import { memo } from 'preact/compat';
import { useState } from 'preact/hooks';
import { messageLevel, type Message } from '../../shared/model/chat.ts';
import { fromBridgeOwner } from '../../shared/model/bridges.ts';
import { isExternalAgent } from '../../shared/model/external-agents.ts';
import { isAgentNotice } from '../../shared/model/message-changes.ts';
import { AgentAvatar, Icon, Spinner } from '../lib/ui.tsx';
import { agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { fullDate, time } from '../lib/format.ts';
import { modelShortName } from '../lib/model-name.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { messageSide } from '../team/people-model.ts';
import { MessageBody } from '../blocks/MessageBody.tsx';
import { TaskMessage } from '../tasks/TaskMessage.tsx';
import { AttachmentList } from './Attachments.tsx';
import { SecretAttachments } from './SecretAttachments.tsx';
import { RunDisclosure } from './RunDisclosure.tsx';
import { InlineEdit, messageMenu } from './MessageActions.tsx';
import { useContextMenu } from '../lib/context-menu.tsx';
import { ReplyQuote } from './ReplyQuote.tsx';
import { WorkingMessage } from './WorkingMessage.tsx';
import { ScheduledLine } from './ScheduledLine.tsx';
import { statusText } from './status-text.ts';
import { messageModelTag } from './model-tag-view.ts';
import { ModelTagMark } from './ModelTagMark.tsx';
import { threadLine, threadsByAnchor } from './threads.ts';
import { chatPanel, chatThread, toggleThread } from '../lib/shell-state.ts';

function Failure(props: { message: Message }) {
  const { message } = props;
  const [busy, setBusy] = useState(false);
  const retry = async () => {
    setBusy(true);
    try { await rpc.call('messages.retry', { messageId: message.id }); } catch (error) { toastError(error, 'Retry failed'); } finally { setBusy(false); }
  };
  return (
    <div class={`message-failure state-${message.state}`} role="status">
      <Icon name={message.state === 'failed' ? 'warning-circle' : 'stop'} size={14} />
      <span>{message.meta.error ?? (message.state === 'failed' ? 'Failed' : 'Stopped')}</span>
      <button type="button" class="text-button" disabled={busy} onClick={() => void retry()}>Retry</button>
    </div>
  );
}

const bridgeKind = (message: Message): unknown => (message.meta.bridge as { kind?: unknown } | undefined)?.kind;

/** K6: the model a person's message asked for or an agent's message recommended – its short name, a pin when pinned; nothing for Auto. */
function ModelTag(props: { message: Message }) {
  return <ModelTagMark tag={messageModelTag(props.message, modelShortName)} />;
}

function Actions(props: { message: Message }) {
  const { message } = props;
  const via = message.meta.model ? ` · ${message.meta.model}${message.meta.effort ? ` ${message.meta.effort}` : ''}` : '';
  const level = messageLevel(message);
  return (
    <div class="message-actions">
      {level === 'important' && <span class="important-marker" title="Important"><Icon name="exclamation-mark" size={12} /></span>}
      {level === 'silent' && !message.meta.call && <Icon name="bell-slash" size={12} class="silent-marker" title="Silent" />}
      {message.meta.ultra === true && <Icon name="lightning" size={12} class="ultra-marker" title="Ultra suggested" />}
      {message.meta.via === 'schedule' && <Icon name="clock" size={12} title="Scheduled" />}
      {message.meta.via === 'voice' && <Icon name={message.meta.call ? 'phone' : 'microphone'} size={12} title={message.meta.call ? `Said in the call · ${message.meta.call.name}` : 'Voice'} />}
      {fromBridgeOwner(message) && <Icon name="chat-text" size={12} title={bridgeKind(message) === 'telegram' ? 'Sent from Telegram' : 'Sent from a linked messenger'} />}
      <ModelTag message={message} />
      <time class="tabular" dateTime={new Date(message.createdAt).toISOString()} title={`${fullDate(message.createdAt)}${via}`}>{time(message.createdAt)}</time>
      {message.editedAt !== undefined && <span class="edited-marker" title={`Edited ${fullDate(message.editedAt)}`}>edited</span>}
      {message.meta.imported === true && <span class="edited-marker" title="Imported from a chat folder (another PC or an export)">imported</span>}
    </div>
  );
}

/** B-078: the quiet line under a message that has a thread – it opens or closes the thread in the side panel. */
function ThreadLink(props: { message: Message }) {
  const thread = threadsByAnchor.value.get(props.message.id);
  const text = thread ? threadLine(thread) : '';
  if (!thread || !text) return null;
  const open = chatPanel.value === 'thread' && chatThread.value === thread.id;
  return (
    <button type="button" class={`thread-link${thread.unread > 0 ? ' unread' : ''}`} aria-expanded={open}
      onClick={() => toggleThread(props.message.conversationId, thread.id)}>
      <Icon name="chat-circle" size={12} /><span>{text}</span>
    </button>
  );
}

/** `runLine`: whether this message carries its run's "Worked … · N steps" line (MessageList decides, message-rows.ts runLineIds; default: every agent message of a run). */
function MessageItemInner(props: { message: Message; runLine?: boolean }) {
  const { message } = props;
  const [editing, setEditing] = useState(false);
  const menu = useContextMenu(() => messageMenu(message, () => setEditing(true)));
  // A streaming answer outside the message list's live block (a call's transcript): the live block in place.
  if (message.authorKind === 'agent' && message.state === 'streaming' && message.runId) return <WorkingMessage key={message.runId} message={message} />;
  // stopped by the person before it wrote anything: the working block stays where it was, marked stopped
  if (message.authorKind === 'agent' && message.state === 'stopped' && message.runId && !message.body.trim() && !message.attachments.length) {
    return <WorkingMessage key={message.runId} message={message} stopped />;
  }
  if (message.kind === 'task') {
    return <div class="message task-message" data-message-id={message.id}><TaskMessage message={message} /></div>;
  }
  if (message.kind === 'status') return <StatusGroup messages={[message]} />;
  const side = messageSide(message);
  const human = side === 'own'; // only the caller's own words are the right-hand bubble
  const streaming = message.state === 'streaming';
  const open = message.authorKind === 'agent' ? () => go.agent(message.authorId) : side === 'person' ? () => go.person(message.authorId) : undefined;
  return (
    <article class={`message ${human ? 'human' : side === 'person' ? 'person' : 'agent'}${messageLevel(message) === 'important' ? ' important' : ''}`} data-message-id={message.id}
      {...(editing ? {} : menu)}>
      {!human && (
        <div class="message-author">
          {open && <AgentAvatar agentId={message.authorId} size={26} working={streaming && message.authorKind === 'agent'} onClick={open} />}
          {open
            ? <button type="button" class="author-name" onClick={open}>{agentName(message.authorId)}</button>
            : <span class="author-name">{message.authorKind === 'external' ? message.authorId.split(':').pop() : agentName(message.authorId)}</span>}
          {isExternalAgent(message.authorId) && <span class="author-tag">External agent</span>}
        </div>
      )}
      {!human && message.runId && props.runLine !== false && <RunDisclosure message={message} />}
      <div class={`message-content${editing ? ' editing' : ''}`}>
        {message.replyTo && <ReplyQuote conversationId={message.conversationId} messageId={message.replyTo} />}
        {editing ? <InlineEdit message={message} onDone={() => setEditing(false)} />
          : message.body ? <MessageBody message={message} /> : streaming ? <Spinner size={14} label="Writing" /> : null}
        {message.attachments.length > 0 && <AttachmentList attachments={message.attachments} conversationId={message.conversationId} />}
        <SecretAttachments ids={message.meta.secrets} />
      </div>
      {(message.state === 'failed' || message.state === 'stopped') && <Failure message={message} />}
      <Actions message={message} />
      <ThreadLink message={message} />
    </article>
  );
}

export const MessageItem = memo(MessageItemInner);

/** Quiet status lines; a burst shows the newest line and expands to all. C6: notices for agents are left out – the message shows the change. */
export function StatusGroup(props: { messages: Message[] }) {
  const [open, setOpen] = useState(false);
  const list = props.messages.filter((message) => !isAgentNotice(message));
  if (!list.length) return null;
  const last = list[list.length - 1];
  const text = (message: Message) => statusText(message); // a cut-off call in the run line's words (status-text.ts)
  if (list.length === 1) {
    if (last.meta.status?.type === 'schedule_created') return <ScheduledLine message={last} />; // B-044: "Scheduled · <when>" → Chat details › Scheduled
    return <div class="status-line" data-message-id={last.id}><span>{text(last)}</span><time class="tabular">{time(last.createdAt)}</time></div>;
  }
  return (
    <div class="status-group" data-message-id={last.id}>
      <button type="button" class="status-line toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'caret-down' : 'caret-right'} size={11} />
        <span>{open ? `${list.length} updates` : text(last)}</span>
        {!open && <span class="status-count tabular">+{list.length - 1}</span>}
        <time class="tabular">{time(last.createdAt)}</time>
      </button>
      {open && list.map((message) => (
        <div class="status-line nested" key={message.id} data-message-id={message.id}><span>{text(message)}</span><time class="tabular">{time(message.createdAt)}</time></div>
      ))}
    </div>
  );
}
