// D5: Claude Code thinking as reasoning blocks (claude/stream.ts): a streamed thinking block has an
// id from its message and index and ends at content_block_stop; a thinking block that arrived only in
// the full assistant message is the fallback (once, also when the CLI repeats the message); empty
// (omitted) and redacted thinking show nothing; subagent thinking never reaches the run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeStreamParser } from '../../../src/runtime/engines/claude/stream.ts';
import type { EngineEvent } from '../../../src/runtime/engines/types.ts';

function parser() {
  const events: EngineEvent[] = [];
  const p = new ClaudeStreamParser((event) => events.push(event), () => 0);
  const thoughts = () => events.filter((event) => event.type === 'reasoning' || event.type === 'reasoning_end');
  return { p, events, thoughts };
}

const streamEvent = (event: Record<string, unknown>, parent?: string) => ({ type: 'stream_event', ...(parent ? { parent_tool_use_id: parent } : {}), event });

test('claude thinking: a streamed block carries message:index and ends at its content_block_stop; the full message does not repeat it', () => {
  const { p, thoughts } = parser();
  p.push(streamEvent({ type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 10 } } }));
  p.push(streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
  p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking the ' } }));
  p.push(streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'tests first.' } }));
  p.push(streamEvent({ type: 'content_block_stop', index: 0 }));
  p.push(streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }));
  p.push(streamEvent({ type: 'content_block_stop', index: 1 }));
  p.push({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Checking the tests first.', signature: 'S' }] } });
  assert.deepEqual(thoughts(), [
    { type: 'reasoning', delta: 'Checking the ', id: 'msg_1:0' },
    { type: 'reasoning', delta: 'tests first.', id: 'msg_1:0' },
    { type: 'reasoning_end', id: 'msg_1:0' },
  ]);
  assert.equal(p.state.contextTokens, 10, 'message_start still counts the context');
});

test('claude thinking: without deltas the full message is the fallback – once; empty and redacted thinking and subagents show nothing', () => {
  const { p, thoughts } = parser();
  const message = { type: 'assistant', message: { id: 'msg_2', content: [
    { type: 'thinking', thinking: 'Weighing two options.', signature: 'S' },
    { type: 'redacted_thinking', data: 'ENCRYPTED' },
    { type: 'thinking', thinking: '', signature: 'S2' },
    { type: 'text', text: 'Option B.' },
  ] } };
  p.push(message);
  p.push(message); // the CLI may repeat a message
  p.push({ type: 'assistant', parent_tool_use_id: 'tu_9', message: { id: 'msg_s', content: [{ type: 'thinking', thinking: 'Subagent thought', signature: 'S' }] } });
  const got = thoughts();
  assert.equal(got.length, 2);
  assert.equal(got[0].type, 'reasoning');
  assert.equal((got[0] as { delta: string }).delta, 'Weighing two options.');
  // B-048: the block's signature rides along, so the thinking can be replayed unchanged.
  assert.deepEqual(got[1], { type: 'reasoning_end', id: (got[0] as { id?: string }).id, signature: 'S' });
  assert.match(String((got[0] as { id?: string }).id), /^msg_2:/);
  assert.equal(p.answer(), 'Option B.');
});
