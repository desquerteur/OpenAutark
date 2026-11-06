// The ping keepalive (http/keepalive.ts, B-077): a socket that showed no sign of life since the last ping is ended;
// any frame counts as life, not only the pong; a tick that comes late because this process stalled pings again and
// ends nobody; the interval is armed only while sockets exist. Fake sockets and a manual clock – no timers run.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { KEEPALIVE_MS, Keepalive } from '../../../src/runtime/http/keepalive.ts';

class FakeWs extends EventEmitter {
  pings = 0;
  ended = false;
  ping(): void { this.pings++; }
  terminate(): void { this.ended = true; this.emit('close'); }
}

test('a silent socket is ended at the second tick; a pong or any message keeps it', () => {
  let now = 0;
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now);
  const silent = new FakeWs();
  const pongs = new FakeWs();
  const talks = new FakeWs();
  for (const ws of [silent, pongs, talks]) keepalive.add(ws as never);
  try {
    now += KEEPALIVE_MS; keepalive.tick();
    assert.deepEqual([silent.pings, pongs.pings, talks.pings], [1, 1, 1]);
    pongs.emit('pong');
    talks.emit('message', Buffer.from('frame')); // a pong stuck behind a big frame: the frame itself proves life
    now += KEEPALIVE_MS; keepalive.tick();
    assert.equal(silent.ended, true);
    assert.equal(pongs.ended, false);
    assert.equal(talks.ended, false);
    assert.equal(keepalive.all().length, 2);
  } finally {
    keepalive.stop();
  }
});

test('a late tick (this process stalled) pings again and ends nobody; the next on-time tick does', () => {
  let now = 0;
  const keepalive = new Keepalive(KEEPALIVE_MS, () => now);
  const ws = new FakeWs();
  keepalive.add(ws as never);
  try {
    now += KEEPALIVE_MS; keepalive.tick();
    now += KEEPALIVE_MS * 3; keepalive.tick(); // 45 s late: its answer may sit unread in this process
    assert.equal(ws.ended, false);
    assert.equal(ws.pings, 2);
    now += KEEPALIVE_MS; keepalive.tick();
    assert.equal(ws.ended, true, 'still no answer after an on-time round');
  } finally {
    keepalive.stop();
  }
});

test('15 s: a dead link is noticed within 15–30 s on either end', () => {
  assert.equal(KEEPALIVE_MS, 15_000);
});
