// Wireless debugging over ADB (PH1) with a fake AdbExec – no real adb runs: host:port and
// pairing-code validation, `adb mdns services` parsing, the fixed argument arrays of pair /
// connect / disconnect, adb's answers turned into results or clear errors (never with the
// code), phone info, the winget/SDK locations where adb is looked for, and (B-044) switching a
// (a USB phone goes to Wi-Fi through the agent's shell – skill phone-adb).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdbPhone, sdkCandidates, type ExecResult } from '../../../src/runtime/phone/adb.ts';
import { isWireless, notConnected, parseAddress, parseCode, parseMdns, pairThenConnect } from '../../../src/runtime/phone/connect.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import { MDNS, fakeAdb, out } from './fakes.ts';

test('host:port and the pairing code are validated before adb runs', () => {
  assert.deepEqual(parseAddress(' 192.168.1.20:37099 '), { host: '192.168.1.20', port: 37099, address: '192.168.1.20:37099' });
  assert.equal(parseAddress('pixel.tail1234.ts.net:5555').address, 'pixel.tail1234.ts.net:5555');
  assert.equal(parseAddress('[fd7a:115c:a1e0::1]:5555').address, '[fd7a:115c:a1e0::1]:5555');
  for (const bad of ['', '192.168.1.20', '192.168.1.20:0', '192.168.1.20:70000', '999.1.1.1:5555', '-rf:5555', 'a b:5555', '192.168.1.20:37099;rm', 'fd7a::1:5555', 'host:', ':5555', `${'a'.repeat(300)}:1`]) {
    assert.throws(() => parseAddress(bad), (error: unknown) => error instanceof WorkforceError && error.code === 'bad_request', bad);
  }
  assert.equal(parseCode('482 916'), '482916');
  assert.equal(parseCode('482-916'), '482916');
  for (const bad of ['', '12345', '1234567', 'abcdef', '12345a']) assert.throws(() => parseCode(bad), /6 digits/, bad);
  assert.equal(isWireless('192.168.1.20:37099'), true);
  assert.equal(isWireless('adb-R58N123-AbCdEf._adb-tls-connect._tcp'), true);
  assert.equal(isWireless('R58N999'), false);
  assert.equal(isWireless('emulator-5554'), false);
});

test('adb mdns services: pairing and connect services, deduplicated; junk and other services skipped', () => {
  assert.deepEqual(parseMdns(MDNS), [
    { name: 'adb-R58N123-AbCdEf', service: 'connect', address: '192.168.1.30:40111' },
    { name: 'adb-R58N123-AbCdEf', service: 'pairing', address: '192.168.1.30:37005' },
    { name: 'adb-XYZ', service: 'connect', address: '192.168.1.20:37099' },
    { name: 'adb-legacy', service: 'connect', address: '192.168.1.40:5555' },
  ]);
  assert.deepEqual(parseMdns(''), []);
  // Connected phones (by address or adb's mDNS serial) are not offered again; pairing dialogs always are.
  const left = notConnected(parseMdns(MDNS), [{ serial: '192.168.1.20:37099' }, { serial: 'adb-R58N123-AbCdEf._adb-tls-connect._tcp' }]);
  assert.deepEqual(left.map((item) => `${item.service} ${item.address}`), ['pairing 192.168.1.30:37005', 'connect 192.168.1.40:5555']);
});

test('pair: one argument array, success with the guid; a wrong code or no dialog says why – never with the code', async () => {
  const ok = fakeAdb([(args) => (args[0] === 'pair' ? out('Successfully paired to 192.168.1.30:37005 [guid=adb-R58N123-AbCdEf]') : undefined)]);
  assert.deepEqual(await ok.phone.pair('192.168.1.30:37005', '482 916'), { address: '192.168.1.30:37005', name: 'adb-R58N123-AbCdEf' });
  assert.deepEqual(ok.calls.at(-1), ['pair', '192.168.1.30:37005', '482916']);
  const wrong = fakeAdb([(args) => (args[0] === 'pair' ? out('Failed: Wrong password or connection was dropped. 482916', 1) : undefined)]);
  await assert.rejects(wrong.phone.pair('192.168.1.30:37005', '482916'), (error: unknown) => {
    assert.ok(error instanceof WorkforceError && error.code === 'bad_request');
    assert.match(error.message, /did not accept the pairing code/);
    assert.doesNotMatch(error.message, /482916/);
    return true;
  });
  const gone = fakeAdb([(args) => (args[0] === 'pair' ? { code: 1, stderr: 'Failed: Unable to start pairing client.' } : undefined)]);
  await assert.rejects(gone.phone.pair('192.168.1.30:37005', '482916'), /Pair device with pairing code/);
  const odd = fakeAdb([(args) => (args[0] === 'pair' ? out('something odd 482916 happened', 1) : undefined)]);
  await assert.rejects(odd.phone.pair('192.168.1.30:37005', '482916'), (error: unknown) => error instanceof Error && !error.message.includes('482916') && /did not complete/.test(error.message));
  // Invalid input never reaches adb.
  const none = fakeAdb();
  await assert.rejects(none.phone.pair('192.168.1.30:37005; reboot', '482916'), /IP address and port/);
  await assert.rejects(none.phone.pair('192.168.1.30:37005', '48291'), /6 digits/);
  assert.equal(none.calls.length, 0);
});

test('connect / disconnect read adb\'s answers (exit code 0 or not) into results or errors', async () => {
  const answers: Record<string, Partial<ExecResult>> = {
    '10.0.0.1:5555': out('connected to 10.0.0.1:5555'),
    '10.0.0.2:5555': out('already connected to 10.0.0.2:5555'),
    '10.0.0.3:5555': out('failed to authenticate to 10.0.0.3:5555', 1),
    '10.0.0.4:5555': out("failed to connect to '10.0.0.4:5555': Connection refused", 1),
    '10.0.0.5:5555': out('cannot connect to 10.0.0.5:5555: No connection could be made because the target machine actively refused it. (10061)'),
  };
  const { phone, calls } = fakeAdb([(args) => (args[0] === 'connect' ? answers[args[1]] : undefined)]);
  assert.deepEqual(await phone.connect('10.0.0.1:5555'), { address: '10.0.0.1:5555', already: false });
  assert.deepEqual(calls.at(-1), ['connect', '10.0.0.1:5555']);
  assert.deepEqual(await phone.connect('10.0.0.2:5555'), { address: '10.0.0.2:5555', already: true });
  await assert.rejects(phone.connect('10.0.0.3:5555'), /Pair it first/);
  await assert.rejects(phone.connect('10.0.0.4:5555'), /ports change after a restart/);
  await assert.rejects(phone.connect('10.0.0.5:5555'), /ports change after a restart/);
  const off = fakeAdb([
    (args) => (args[0] === 'disconnect' && args[1] === '10.0.0.1:5555' ? out('disconnected 10.0.0.1:5555') : undefined),
    (args) => (args[0] === 'disconnect' ? { code: 1, stderr: "error: no such device '10.0.0.9:5555'" } : undefined),
  ]);
  assert.deepEqual(await off.phone.disconnect('10.0.0.1:5555'), { serial: '10.0.0.1:5555', was: true });
  assert.deepEqual(await off.phone.disconnect('10.0.0.9:5555'), { serial: '10.0.0.9:5555', was: false });
  assert.deepEqual(await off.phone.disconnect('adb-R58N123-AbCdEf._adb-tls-connect._tcp'), { serial: 'adb-R58N123-AbCdEf._adb-tls-connect._tcp', was: false });
  await assert.rejects(off.phone.disconnect('R58N999'), /Only phones on wireless debugging/);
});

test('discover: mdns services nearby', async () => {
  const { phone, calls } = fakeAdb([(args) => (args[0] === 'mdns' ? out(MDNS) : undefined)]);
  assert.equal((await phone.discover()).length, 4);
  assert.deepEqual(calls.at(-1), ['mdns', 'services']);
  // An adb without mDNS support simply finds nobody.
  const old = fakeAdb([(args) => (args[0] === 'mdns' ? { code: 1, stderr: 'unknown command mdns' } : undefined)]);
  assert.deepEqual(await old.phone.discover(), []);
});

test('pairThenConnect: connects to the given address, else to the phone found nearby on the same host', async () => {
  const { phone, calls } = fakeAdb([
    (args) => (args[0] === 'pair' ? out('Successfully paired to 192.168.1.30:37005 [guid=adb-R58N123-AbCdEf]') : undefined),
    (args) => (args[0] === 'mdns' ? out(MDNS) : undefined),
    (args) => (args[0] === 'connect' ? out(`connected to ${args[1]}`) : undefined),
  ]);
  assert.deepEqual(await pairThenConnect(phone, { address: '192.168.1.30:37005', code: '482916' }), { paired: '192.168.1.30:37005', connected: '192.168.1.30:40111' });
  assert.deepEqual(await pairThenConnect(phone, { address: '192.168.1.30:37005', code: '482916', connect: '192.168.1.30:41000' }), { paired: '192.168.1.30:37005', connected: '192.168.1.30:41000' });
  assert.ok(calls.some((args) => args.join(' ') === 'connect 192.168.1.30:41000'));
  await assert.rejects(pairThenConnect(phone, { address: '192.168.1.30:37005', code: '482916', connect: 'nope' }), /IP address and port/);
  const lonely = fakeAdb([(args) => (args[0] === 'pair' ? out('Successfully paired to 10.1.1.1:37005') : undefined)]);
  const result = await pairThenConnect(lonely.phone, { address: '10.1.1.1:37005', code: '482916' });
  assert.equal(result.paired, '10.1.1.1:37005');
  assert.equal(result.connected, undefined);
  assert.match(result.connectError ?? '', /under Wireless debugging/);
});

test('adb is also looked for where winget puts Google.PlatformTools; a missing adb is looked for again', async () => {
  const candidates = sdkCandidates({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32', 'C:\\Users\\me');
  assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\adb.exe'));
  assert.ok(candidates.includes('C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\\platform-tools\\adb.exe'));
  const forced: Array<boolean | undefined> = [];
  let installed = false;
  const phone = new AdbPhone({
    log: new MemoryLogger(), exec: async () => ({ code: 0, stdout: new Uint8Array(), stderr: '' }), env: {}, platform: 'linux', home: '/home/x', exists: () => false,
    finder: { find: async (_id, options) => { forced.push(options?.force); return installed ? { command: '/usr/bin/adb', prefixArgs: [], path: '/usr/bin/adb' } : null; } },
  });
  assert.equal(await phone.available(), false);
  installed = true;
  assert.equal(await phone.available(), true, 'found once it is installed');
  assert.deepEqual(forced, [undefined, undefined]);
});
