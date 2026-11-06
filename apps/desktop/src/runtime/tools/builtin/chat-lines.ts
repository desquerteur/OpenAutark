// Chat lines of the read tools (B-050 K5): chat.read and chat.search show a message exactly as the agent's context
// does – context/render.ts renderMessages: time, author by name (a person of the organisation too), its level,
// task link, reply, the Telegram note, files – each message on its own, led by its "#seq" (a search hit also by its
// chat), plus the file ids chat.send can attach again. An edit or delete notice is left out where the context leaves
// it out (render.ts changeNotice over the whole page). One message asked for by seq comes in full: render.ts cuts a
// long body and points to chat.read for the rest.
// Owns: that framing. Never: a line format of its own (render.ts owns it), or images.

import type { Message } from '../../../shared/model/chat.ts';
import type { ToolContext } from '../types.ts';
import { renderContext } from '../../context/delta.ts';
import { BODY_CAP, changeNotice, lineIndex, neutralize, renderMessages, type RenderContext } from '../../context/render.ts';
import { clip } from './util.ts';

const fileIds = (message: Message) => (message.attachments.length ? `[files: ${message.attachments.map((file) => `${file.name} (${file.fileId})`).join(', ')}]` : '');

/** One message as the context renders it ('' when the context shows nothing for it). */
function rendered(rctx: RenderContext, message: Message): string {
  return renderMessages(rctx, [message], { images: false }).lines.join('\n');
}

/** chat.read: the page in seq order; `full`: the one message's whole text after its line when the context cuts it. */
export function readLines(ctx: ToolContext, messages: Message[], options: { full?: boolean } = {}): string[] {
  const rctx = renderContext(ctx.services, ctx.agent.id);
  const { byId, latest } = lineIndex(messages);
  const out: string[] = [];
  for (const message of messages) {
    if (message.kind === 'status' && changeNotice(rctx, message, byId, latest) === null) continue; // as in the context
    const line = rendered(rctx, message);
    if (!line) continue;
    out.push([`#${message.seq} ${line}`, fileIds(message)].filter(Boolean).join('\n'));
    if (options.full && message.kind === 'text' && message.body.length > BODY_CAP) out.push(`Full text of #${message.seq}:`, neutralize(message.body));
  }
  return out;
}

/** chat.search: each hit as its line with the matching snippet for the body, led by "<chat id> #seq". */
export function hitLines(ctx: ToolContext, hits: Array<{ message: Message; snippet: string }>): string[] {
  const rctx = renderContext(ctx.services, ctx.agent.id);
  return hits.map(({ message, snippet }) => {
    const line = rendered(rctx, { ...message, body: clip(snippet, 400), attachments: [] });
    return `${message.conversationId} #${message.seq} ${line || clip(snippet, 400)}`;
  });
}
