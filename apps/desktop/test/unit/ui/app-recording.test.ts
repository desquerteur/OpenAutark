// Owns: the host recording gate (no bridge call opens a device) and the bridge's capability
// check. Never: opens a real device; the Electron test covers recording and handing back a take.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_METHODS, APP_TOOLS } from '../../../src/shared/blocks/app-bridge.ts';
import { appRecording, type AppRecordingOptions } from '../../../src/ui/blocks/app-recording.ts';
import { isAction, toolResult } from '../../../src/ui/blocks/app-host.ts';
import { callHostTool } from '../../../src/ui/blocks/app-tools.ts';
import { session } from '../../../src/ui/lib/session.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';

test('only a to-do with the granted recording kinds may open the host recorder', async () => {
  const opened: AppRecordingOptions[] = [];
  const open = async (options: AppRecordingOptions) => { opened.push(options); return toolResult({ fileId: 'take' }); };
  const block = { todo: true, allow: 'microphone; camera' };
  for (const [candidate, args] of [
    [{ ...block, todo: false }, {}], [{ ...block, allow: '' }, {}],
    [{ ...block, allow: 'microphone' }, { mode: 'video' }], [block, { mode: 'screen' }],
    [block, { maxSeconds: 0 }], [block, { maxSeconds: NaN }], [block, { maxSeconds: '20' }],
  ] as const) assert.equal((await appRecording(candidate, args, open)).isError, true);
  assert.equal(opened.length, 0);
  assert.equal((await appRecording(block, {}, open)).isError, undefined);
  await appRecording(block, { mode: 'video', maxSeconds: 900, script: 'a'.repeat(13_000) }, open);
  assert.deepEqual(opened[0], { mode: 'audio', maxSeconds: 120, script: '' });
  assert.deepEqual([opened[1].mode, opened[1].maxSeconds, opened[1].script.length], ['video', 600, 12_000]);
});

test('recording needs file capabilities and a to-do; a bridge call remains a limited action', async (t) => {
  const previous = session.value;
  t.after(() => { session.value = previous; });
  const block = { messageId: 'msg_record', index: 0, todo: true };
  let calls = 0;
  const record = async () => { calls++; return toolResult({ fileId: 'take' }); };
  session.value = { kind: 'device', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  assert.equal((await callHostTool(block, APP_TOOLS.record, {}, record)).isError, true);
  assert.equal(calls, 0);
  session.value = { kind: 'owner', allowedMethods: [], capabilities: [] } as unknown as SessionInfo;
  assert.equal((await callHostTool({ ...block, todo: false }, APP_TOOLS.record, {}, record)).isError, true);
  assert.equal((await callHostTool(block, APP_TOOLS.record, {})).isError, true);
  assert.equal(calls, 0);
  await callHostTool(block, APP_TOOLS.record, {}, record);
  assert.equal(calls, 1);
  assert.equal(isAction({ method: APP_METHODS.toolsCall, params: { name: APP_TOOLS.record } }), true);
});
