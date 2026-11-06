// A stand-in for the Claude Code CLI in the login guard tests (claude-login-guard.test.ts): a real process that, like the
// CLI, may still be saving a refreshed sign-in after its answer. It never reads or writes a sign-in; it only appends
// JSON lines {pid, home, kind, event, at} to $FAKE_DIR/log.jsonl (start, answered – a probe's answer –, input-ended,
// saved, exit).
// Kinds by arguments: `auth status --json`, the probe (`-p --safe-mode`, answers initialize and get_usage), a turn (`-p`).
// FAKE_MODE: '' ends by itself FAKE_SAVE_MS after its input ended ("saved", exit 0; auth status: after its answer);
//   'hang' answers, then ignores the end of its input and never exits by itself;
//   'slow' answers the probe only after FAKE_ANSWER_MS;
//   a turn: an interrupt is answered only after FAKE_INTERRUPT_MS (a refresh in flight blocks it).
// Owns: nothing in production. Never imported by src/.

import { appendFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const kind = args.includes('auth') ? 'status' : args.includes('--safe-mode') ? 'probe' : 'turn';
const mode = process.env.FAKE_MODE ?? '';
const saveMs = Number(process.env.FAKE_SAVE_MS ?? 1500);
const home = process.env.CLAUDE_CONFIG_DIR ?? '';
const log = (event) => appendFileSync(path.join(process.env.FAKE_DIR, 'log.jsonl'), `${JSON.stringify({ pid: process.pid, home, kind, event, at: Date.now() })}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const keepAlive = () => setInterval(() => {}, 1000);
const finish = () => setTimeout(() => { log('saved'); log('exit'); process.exit(0); }, saveMs);

log('start');
if (kind === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' }));
  if (mode === 'hang') keepAlive(); else finish();
} else {
  let buffer = '';
  let session = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onMessage(JSON.parse(line));
    }
  });
  process.stdin.on('end', () => { log('input-ended'); if (mode !== 'hang') finish(); });
  if (mode === 'hang') keepAlive();
  const at = args.indexOf('--session-id');
  session = at >= 0 ? args[at + 1] : 'fake-session';

  function onMessage(message) {
    if (message.type === 'control_request' && kind === 'probe') {
      const answer = () => {
        send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: message.request.subtype === 'initialize' ? { models: [] } : {} } });
        log('answered');
      };
      if (mode === 'slow') setTimeout(answer, Number(process.env.FAKE_ANSWER_MS ?? 1500)); else answer();
      return;
    }
    if (message.type === 'control_request' && message.request?.subtype === 'interrupt') {
      setTimeout(() => send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Request interrupted by user', session_id: session }), Number(process.env.FAKE_INTERRUPT_MS ?? 0));
      return;
    }
    if (message.type !== 'user') return;
    send({ type: 'system', subtype: 'init', session_id: session });
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Working' } } });
    if (process.env.FAKE_TURN === 'answer') send({ type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: session });
  }
}
