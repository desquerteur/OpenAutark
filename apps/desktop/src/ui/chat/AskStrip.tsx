// The important question above the chat composer (B-078 D9, owner 06.11.: what one clicks is written into the input
// line first): one fixed line with the asking agent's avatar, the question and its quick answers
// (tasks/ask-strip-model.ts – the newest open important to-do anchored to a message, this chat's first). A click on
// the question jumps to its message (tasks/jump.ts jumpToMessage: the chat opens, focusMessage scrolls there). An
// answer button fills the composer with that answer as a reply to the message (setReply + composerFill – only into an
// empty field; the person sends, and runtime/tasks/reply-answer.ts completes the to-do with their line); "Reply"
// only sets the reply. The buttons inside the message itself still answer directly. Nothing shown: no line at all.
// Owns: the strip's markup. Never: answers for the person, or sends anything itself.

import { AgentAvatar } from '../lib/avatar.tsx';
import { navigate } from '../lib/router.ts';
import { composerFill } from '../lib/shell-state.ts';
import { agentName, todos } from '../lib/store.ts';
import { plainPreview } from '../lib/format.ts';
import { jumpToMessage } from '../tasks/jump.ts';
import { stripAnswers, stripAsk } from '../tasks/ask-strip-model.ts';
import { draftFor, setReply } from './composer/draft.ts';

export function AskStrip(props: { conversationId: string }) {
  const todo = stripAsk(todos.value, props.conversationId);
  if (!todo || !todo.messageId || !todo.conversationId) return null;
  const chatId = todo.conversationId;
  const messageId = todo.messageId;
  const here = chatId === props.conversationId;
  const reply = (text?: string) => {
    if (!here) navigate({ view: 'chat', id: chatId });
    setReply(chatId, messageId);
    composerFill.value = { conversationId: chatId, text: text ?? draftFor(chatId).peek().text }; // Reply alone keeps the draft
  };
  const answers = stripAnswers(todo.widget);
  const who = todo.createdBy && todo.createdBy !== 'human' && todo.createdBy !== 'system' ? todo.createdBy : undefined;
  return (
    <div class="ask-strip" role="region" aria-label="Important question">
      {who ? <AgentAvatar agentId={who} size={22} /> : <span class="ask-strip-dot" aria-hidden="true" />}
      <button type="button" class="ask-strip-text" title={here ? 'Show the question' : `Show the question in ${todo.conversationTitle || 'its chat'}`}
        onClick={() => void jumpToMessage(chatId, messageId)}>
        {who && <span class="ask-strip-who">{agentName(who)}</span>}
        <span class="ask-strip-question">{plainPreview(todo.title, 160)}</span>
      </button>
      <span class="ask-strip-answers">
        {answers.map((answer) => (
          <button key={answer} type="button" class="ask-strip-answer" title={`Reply "${answer}"`} onClick={() => reply(answer)}>{answer}</button>
        ))}
        <button type="button" class="ask-strip-answer quiet" onClick={() => reply()}>Reply</button>
      </span>
    </div>
  );
}
