// DEV5B, the page side of "Ask this PC for access" (ui/pwa/access.ts) on a fake page: one long
// request at a time and only while visible, the next one after an open answer, the token handed
// to `paired` once, declined/expired states, a reload resuming the stored ticket, one retry after
// a failed request and never a spin on an early 'pending'.
// Owns: these assertions only. Never: a real browser, fetch or runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccessFlow, type AccessEnv } from '../../../src/ui/pwa/access.ts';
import type { AccessWait } from '../../../src/shared/api/methods.ts';

const TICKET = 't'.repeat(43);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function page() {
  let now = 1_000_000;
  let visible = true;
  let onChange: (() => void) | null = null;
  const stored: { value: string | null } = { value: null };
  const waits: Array<{ ticket: string; signal: AbortSignal; resolve: (value: AccessWait) => void; reject: (error: Error) => void }> = [];
  const retries: Array<{ fn: () => void; ms: number }> = [];
  const paired: string[] = [];
  let requests = 0;
  const env: AccessEnv = {
    request: async () => { requests++; return { id: 'tok_1', ticket: TICKET, code: '4821', expiresAt: now + 300_000 }; },
    wait: (ticket, signal) => new Promise<AccessWait>((resolve, reject) => {
      waits.push({ ticket, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    name: () => 'Android · Chrome',
    now: () => now,
    visible: () => visible,
    watchVisibility: (change) => { onChange = change; return () => { onChange = null; }; },
    load: () => stored.value,
    save: (value) => { stored.value = value; },
    paired: (token) => { paired.push(token); },
    later: (fn, ms) => { const entry = { fn, ms }; retries.push(entry); return () => { const index = retries.indexOf(entry); if (index >= 0) retries.splice(index, 1); }; },
  };
  return {
    env, waits, retries, paired, stored, requests: () => requests,
    advance: (ms: number) => { now += ms; },
    show: (value: boolean) => { visible = value; onChange?.(); },
    watching: () => onChange !== null,
  };
}

test('ask → the code while waiting; an open answer sends the next long request; accepted hands the token over once', async () => {
  const p = page();
  const flow = createAccessFlow(p.env);
  await flow.ask();
  assert.deepEqual(flow.state.value, { step: 'waiting', code: '4821', expiresAt: 1_000_000 + 300_000 });
  assert.equal(p.waits.length, 1);
  assert.equal(p.waits[0].ticket, TICKET);
  assert.ok(p.stored.value?.includes('4821'), 'the request survives a reload of this tab');

  await flow.ask(); // a second tap while waiting does nothing
  assert.equal(p.requests(), 1);

  p.advance(55_000);
  p.waits[0].resolve({ status: 'pending', expiresAt: 1_300_000 });
  await tick();
  assert.equal(p.waits.length, 2, 'the next long request right away');

  p.waits[1].resolve({ status: 'accepted', token: 'device-token', deviceId: 'dev_1', access: 'todo' });
  await tick();
  assert.deepEqual(flow.state.value, { step: 'accepted', access: 'todo' });
  assert.deepEqual(p.paired, ['device-token']);
  assert.equal(p.stored.value, null);
  assert.equal(p.watching(), false);
});

test('only while visible: hidden aborts the long request, visible sends it again', async () => {
  const p = page();
  const flow = createAccessFlow(p.env);
  await flow.ask();
  p.show(false);
  assert.equal(p.waits[0].signal.aborted, true);
  await tick();
  assert.equal(p.waits.length, 1, 'nothing is sent while hidden');
  p.show(true);
  await tick();
  assert.equal(p.waits.length, 2);
  assert.equal(p.retries.length, 0);
  assert.equal(flow.state.value.step, 'waiting');
});

test('declined and expired end the wait; the person may ask again', async () => {
  const p = page();
  const flow = createAccessFlow(p.env);
  await flow.ask();
  p.waits[0].resolve({ status: 'denied', reason: 'The PC declined this device.' });
  await tick();
  assert.deepEqual(flow.state.value, { step: 'denied', reason: 'The PC declined this device.' });
  await flow.ask();
  assert.equal(p.requests(), 2);
  p.waits[1].resolve({ status: 'expired' });
  await tick();
  assert.deepEqual(flow.state.value, { step: 'expired' });
  assert.deepEqual(p.paired, []);
});

test('a failed request is retried once later, an early "pending" never spins, a reload resumes the stored ticket', async () => {
  const p = page();
  const flow = createAccessFlow(p.env);
  await flow.ask();
  p.waits[0].reject(new Error('network down'));
  await tick();
  assert.equal(p.waits.length, 1);
  assert.equal(p.retries.length, 1, 'one retry is scheduled');
  p.retries.shift()!.fn();
  await tick();
  assert.equal(p.waits.length, 2);
  p.waits[1].resolve({ status: 'pending', expiresAt: 1_300_000 }); // came back at once
  await tick();
  assert.equal(p.waits.length, 2, 'no immediate next request');
  assert.equal(p.retries.length, 1);

  const reloaded = createAccessFlow(p.env); // same tab storage
  reloaded.resume();
  assert.deepEqual(reloaded.state.value, { step: 'waiting', code: '4821', expiresAt: 1_300_000 });
  p.advance(1_000_000);
  const later = createAccessFlow(p.env);
  later.resume();
  assert.deepEqual(later.state.value, { step: 'idle' }, 'a stale stored request is dropped');
  assert.equal(p.stored.value, null);
});

test('the PC away: after five failed requests in a row the page stops trying and says so', async () => {
  const p = page();
  const flow = createAccessFlow(p.env);
  await flow.ask();
  for (let attempt = 1; attempt <= 5; attempt++) {
    p.waits[p.waits.length - 1].reject(new Error('network down'));
    await tick();
    if (attempt < 5) {
      assert.equal(p.retries.length, 1, `retry ${attempt} is scheduled`);
      assert.equal(p.retries[0].ms, 3000 * attempt, 'each retry waits longer');
      p.retries.shift()!.fn();
      await tick();
    }
  }
  assert.deepEqual(flow.state.value, { step: 'failed', message: 'This PC cannot be reached right now.' });
  assert.equal(p.retries.length, 0);
  assert.equal(p.stored.value, null);
});

test('a refused request shows why', async () => {
  const p = page();
  p.env.request = async () => { throw new Error('Phone access is turned off on the PC.'); };
  const flow = createAccessFlow(p.env);
  await flow.ask();
  assert.deepEqual(flow.state.value, { step: 'failed', message: 'Phone access is turned off on the PC.' });
  flow.cancel();
  assert.deepEqual(flow.state.value, { step: 'idle' });
});

test('Remote: a #connect= address asks with its ticket at once; the typed code is sent as proof; such a request has no code to compare', async () => {
  const p = page();
  const proofs: unknown[] = [];
  let taken = false;
  p.env.request = async (_name, proof) => { proofs.push(proof); return { id: 'tok_2', ticket: TICKET, code: '1111', expiresAt: 1_300_000, proven: true }; };
  p.env.takeTicket = () => { if (taken) return undefined; taken = true; return 'q'.repeat(43); };
  const flow = createAccessFlow(p.env);
  flow.resume();
  await tick();
  assert.deepEqual(proofs, [{ ticket: 'q'.repeat(43) }], 'the scanned ticket, once');
  assert.deepEqual(flow.state.value, { step: 'waiting', code: '1111', expiresAt: 1_300_000, proven: true });
  flow.cancel();
  await flow.ask({ code: '482913' });
  assert.deepEqual(proofs.at(-1), { code: '482913' });
  flow.resume(); // nothing left in the address: keeps the current request
  assert.equal(proofs.length, 2);
});
