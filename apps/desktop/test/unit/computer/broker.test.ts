// Desktop broker (B-077): handshake, sealed typing and the driver choice against a fake broker on a test pipe
// (the real worker is resources/broker/Worker.cs; this fake mirrors its handshake and Sealer.Open).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { brokerLease, brokerState, lockedDesktop, type BrokerAccess } from '../../../src/runtime/computer/broker.ts';
import { createHelper } from '../../../src/runtime/computer/drivers.ts';
import { WindowsHelper } from '../../../src/runtime/computer/helper.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { fakeSpawn, testSupervisor } from '../engines/fakes.ts';

const mac = (key: Buffer, label: string, ...parts: Buffer[]) => createHmac('sha256', key).update(Buffer.concat([Buffer.from(label), ...parts])).digest();
let pipes = 0;
const pipeName = () => `\\\\.\\pipe\\autark-broker-test-${process.pid}-${++pipes}`;

interface Seen { requests: Array<Record<string, unknown>>; opened: string[] }

/** A fake worker: greets, checks the hello, proves the key, answers each op and opens sealed text like Worker.cs. */
async function fakeBroker(key: Buffer, desktop: string, proveWith = key): Promise<{ pipe: string; seen: Seen; close(): Promise<void> }> {
  const seen: Seen = { requests: [], opened: [] };
  const pipe = pipeName();
  const server = net.createServer((socket) => {
    const serverNonce = randomBytes(16);
    let session: Buffer | undefined;
    let buffer = '';
    socket.write(`${JSON.stringify({ broker: 1, nonce: serverNonce.toString('base64') })}\n`);
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const message = JSON.parse(line);
        if (!session) {
          const clientNonce = Buffer.from(message.nonce, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(message.hello, 'base64'), mac(key, 'hello', serverNonce, clientNonce)));
          session = mac(key, 'session', serverNonce, clientNonce);
          socket.write(`${JSON.stringify({ ready: true, protocol: 4, pid: 7, dpiAware: true, proof: mac(proveWith, 'proof', serverNonce, clientNonce).toString('base64'), desktop })}\n`);
          continue;
        }
        seen.requests.push(message);
        const sealed = message.args?.sealed;
        if (sealed) {
          const iv = Buffer.from(sealed.iv, 'base64');
          const data = Buffer.from(sealed.data, 'base64');
          assert.ok(timingSafeEqual(Buffer.from(sealed.mac, 'base64'), mac(mac(session, 'mac'), `${message.id}\n${message.op}\n`, iv, data)));
          const decipher = createDecipheriv('aes-256-cbc', mac(session, 'enc'), iv);
          seen.opened.push(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
        }
        socket.write(`${JSON.stringify({ id: message.id, ok: true, result: { done: true }, desktop })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  return { pipe, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function helperOn(pipe: string, key: Buffer): WindowsHelper {
  const log = new MemoryLogger();
  return new WindowsHelper({ supervisor: { spawn: () => brokerLease({ pipe, key, log }) }, scriptPath: 'unused.ps1', log });
}

test('the broker answers the helper protocol; typed text and set_value leave only sealed', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Winlogon');
  const helper = helperOn(broker.pipe, key);
  assert.deepEqual(await helper.call('tree', { hwnd: 5 }), { done: true });
  await helper.call('type', { text: 'pässwort\n' });
  await helper.call('act', { rid: '3', action: 'set_value', value: 'hunter22' });
  assert.deepEqual(broker.seen.requests[0], { id: 1, op: 'tree', args: { hwnd: 5 } });
  assert.equal(broker.seen.requests[1].op, 'type_secret');
  assert.deepEqual(broker.seen.opened, ['pässwort\n', 'hunter22']);
  const wire = JSON.stringify(broker.seen.requests);
  assert.ok(!wire.includes('hunter22') && !wire.includes('sswort'), 'no typed text in clear on the pipe');
  assert.deepEqual((broker.seen.requests[2].args as Record<string, unknown>).rid, '3');
  assert.equal(brokerState.via, 'broker');
  assert.equal(brokerState.desktop, 'Winlogon');
  assert.equal(lockedDesktop(), true);
  await helper.dispose();
  await broker.close();
});

test('a pipe that cannot prove the installation key is not used', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Default', randomBytes(32));
  const helper = helperOn(broker.pipe, key);
  await assert.rejects(helper.call('ping'), (error: unknown) => error instanceof WorkforceError && error.code === 'unavailable');
  assert.equal(broker.seen.requests.length, 0);
  await helper.dispose();
  await broker.close();
});

test('drivers.ts takes the broker whenever it is reachable, else the PowerShell helper', async () => {
  const key = randomBytes(32);
  const broker = await fakeBroker(key, 'Default');
  let reachable = false;
  const access: BrokerAccess = { reachable: () => reachable, lease: (log) => brokerLease({ pipe: broker.pipe, key, log }) };
  const fake = fakeSpawn((call) => {
    call.child.onLine = (message) => call.child.send({ id: message.id, ok: true, result: { from: 'powershell' } });
    setImmediate(() => call.child.send({ ready: true, protocol: 4, pid: 1, dpiAware: true }));
  });
  const deps = { supervisor: testSupervisor(fake.spawn), resourcesDir: 'C:\\app\\resources', log: new MemoryLogger(), unpacked: (file: string) => file, broker: access };
  const viaShell = createHelper('win32', deps);
  assert.deepEqual(await viaShell.call('ping'), { from: 'powershell' });
  assert.equal(fake.calls[0].command, 'powershell.exe');
  assert.equal(brokerState.via, 'powershell');
  assert.equal(lockedDesktop(), false);
  await viaShell.dispose();
  reachable = true;
  const viaBroker = createHelper('win32', deps);
  assert.deepEqual(await viaBroker.call('ping'), { done: true });
  assert.equal(fake.calls.length, 1, 'no PowerShell started');
  assert.equal(brokerState.via, 'broker');
  assert.equal(lockedDesktop(), false); // Default desktop: unlocked
  await viaBroker.dispose();
  await broker.close();
});
