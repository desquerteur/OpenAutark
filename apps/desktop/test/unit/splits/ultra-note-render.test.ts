// B-057 S17 (owner 30.10.2026): a person's message that suggested Ultra carries ULTRA_NOTE wherever the agent reads it –
// with text, and (review fix) also without text: files, a selection or secrets only. An agent's own line never carries it.
// Owns: these assertions only. Never: an engine.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../context/fixture.ts';
import { renderMessages, type RenderContext } from '../../../src/runtime/context/render.ts';
import { ULTRA_NOTE } from '../../../src/runtime/context/split-section.ts';
import type { Message } from '../../../src/shared/model/chat.ts';

const T0 = Date.UTC(2026, 9, 30, 21, 0);

test('the Ultra note: on a text message, on a files-only message, never without the suggestion or on an agent line', () => {
  const f = fixture();
  const ctx: RenderContext = { services: f.services, agentId: f.vid.id, humanName: 'Alex', zone: 'UTC', now: T0 + 3_600_000 };
  let seq = 0;
  const line = (over: Partial<Message>): Message => {
    seq += 1;
    return {
      id: `msg_${seq}`, conversationId: 'ch_launch', seq, authorId: 'human', authorKind: 'human', kind: 'text', body: `line ${seq}`, attachments: [],
      mentions: [], priority: 'normal', state: 'final', silent: false, meta: {}, createdAt: T0 + seq * 60_000, ...over,
    };
  };
  const text = renderMessages(ctx, [
    line({ body: 'Review all six contracts', meta: { ultra: true } }),
    line({ body: 'Thanks' }),
    line({ body: '', attachments: [{ fileId: 'fil_1', name: 'contracts.zip', mime: 'application/zip', size: 2048 }], meta: { ultra: true } }),
    line({ authorId: f.vid.id, authorKind: 'agent', body: 'On it', meta: { ultra: true } }),
  ], { images: false }).lines.join('\n');
  assert.ok(text.includes(`Review all six contracts ${ULTRA_NOTE}`), text);
  assert.equal(text.split(ULTRA_NOTE).length - 1, 2, 'the text message and the files-only message – not "Thanks", not the agent\'s line');
  assert.match(text, /contracts\.zip/);
});
