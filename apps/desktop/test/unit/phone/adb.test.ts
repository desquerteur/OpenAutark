// Phone use over ADB with a fake adb: command building, device selection, bounds validation,
// text escaping, key allow-list, screenshot downscale, and uiautomator XML parsing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdbPhone, inputText, keycode, sdkCandidates, shQuote, type ExecResult } from '../../../src/runtime/phone/adb.ts';
import { parseBounds, parseDevices, parseDump, parseWmSize, renderDump, screenOf } from '../../../src/runtime/phone/uiautomator.ts';
import { encodePng, pngSize } from '../../../src/runtime/computer/png.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { fakeSpawn, testSupervisor } from '../engines/fakes.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.example" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
  <node index="0" text="" resource-id="android:id/content" class="android.widget.LinearLayout" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[0,72][1080,2400]">
    <node index="0" text="Hello &amp; welcome" resource-id="com.example:id/title" class="android.widget.TextView" package="com.example" content-desc="" clickable="false" enabled="true" bounds="[42,200][1038,300]" />
    <node index="1" text="hunter2" resource-id="com.example:id/pin" class="android.widget.EditText" package="com.example" content-desc="" clickable="true" enabled="true" focused="true" password="true" bounds="[42,400][1038,520]" />
    <node index="2" text="" resource-id="com.example:id/send" class="android.widget.ImageButton" package="com.example" content-desc="Send" clickable="true" enabled="false" bounds="[900,2200][1040,2340]" />
  </node>
</node>
</hierarchy>`;

const DEVICES = 'List of devices attached\n192.168.1.20:37099      device product:oriole model:Pixel_6 device:oriole transport_id:3\nR58N123 unauthorized usb:1-1 transport_id:4\n\n';

function fakeAdb(answers: Array<(args: string[]) => Partial<ExecResult> | undefined> = []) {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push([command, ...args]);
    for (const answer of answers) {
      const result = answer(args);
      if (result) return { code: 0, stdout: new Uint8Array(), stderr: '', ...result };
    }
    if (args[0] === 'devices') return { code: 0, stdout: Buffer.from(DEVICES), stderr: '' };
    return { code: 0, stdout: new Uint8Array(), stderr: '' };
  };
  const phone = new AdbPhone({ log: new MemoryLogger(), exec, finder: { find: async () => ({ command: 'C:\\sdk\\adb.exe', prefixArgs: [], path: 'C:\\sdk\\adb.exe' }) } });
  return { phone, calls };
}

test('uiautomator dumps become a compact outline; passwords are masked; bounds give tap points', () => {
  const nodes = parseDump(DUMP);
  assert.equal(nodes.length, 5);
  assert.equal(nodes[2].text, 'Hello & welcome');
  assert.equal(nodes[2].parent, 1);
  assert.equal(nodes[3].text, '••••••••');
  assert.deepEqual(nodes[4].bounds, [900, 2200, 1040, 2340]);
  assert.deepEqual(screenOf(nodes), { width: 1080, height: 2400 });
  const outline = renderDump(nodes);
  assert.equal(outline.text, [
    '- TextView "Hello & welcome" #title @540,250',
    '- EditText "••••••••" #pin (tap) @540,460 [focused]',
    '- ImageButton (Send) #send (tap) @970,2270 [disabled]',
  ].join('\n'));
  assert.equal(parseBounds('[1,2][1,9]'), undefined); // empty area
  assert.deepEqual(parseDevices(DEVICES), [
    { serial: '192.168.1.20:37099', state: 'device', model: 'Pixel 6', product: 'oriole', transport: '3' },
    { serial: 'R58N123', state: 'unauthorized', model: undefined, product: undefined, transport: '4' },
  ]);
  assert.deepEqual(parseWmSize('Physical size: 1080x2400\nOverride size: 720x1600'), { width: 720, height: 1600 });
});

test('commands are argument arrays with the selected device; text and keys are escaped and allow-listed', async () => {
  const { phone, calls } = fakeAdb([(args) => (args.includes('wm') ? { stdout: Buffer.from('Physical size: 1080x2400') } : undefined)]);
  await phone.tap(undefined, 540.4, 0);
  assert.deepEqual(calls.at(-1), ['C:\\sdk\\adb.exe', '-s', '192.168.1.20:37099', 'shell', 'input', 'tap', '540', '0']);
  await assert.rejects(phone.tap(undefined, 5000, 10), /outside the phone screen/);
  await assert.rejects(phone.tap(undefined, Number.NaN, 10), /x must be a finite number/);
  await phone.swipe(undefined, { x: 500, y: 1800 }, { x: 500, y: 600 }, 350);
  assert.deepEqual(calls.at(-1)!.slice(3), ['shell', 'input', 'swipe', '500', '1800', '500', '600', '350']);
  await phone.type(undefined, "it's here\nok");
  const typed = calls.filter((call) => call.includes('input') && (call.includes('text') || call.includes('keyevent')));
  assert.deepEqual(typed.slice(-3).map((call) => call.slice(4)), [['input', 'text', "'it'\\''s%shere'"], ['input', 'keyevent', 'KEYCODE_ENTER'], ['input', 'text', "'ok'"]]);
  await assert.rejects(phone.type(undefined, 'Grüße'), /ASCII text only/);
  assert.equal(await phone.key(undefined, 'back'), 'KEYCODE_BACK');
  assert.throws(() => keycode('power'), /not one of the keys this tool sends/);
  assert.equal(shQuote("a'b"), "'a'\\''b'");
  assert.equal(inputText('a b'), "'a%sb'");
  await phone.open(undefined, { url: 'https://example.com/x?y=1' });
  assert.deepEqual(calls.at(-1)!.slice(3), ['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', "'https://example.com/x?y=1'"]);
  await assert.rejects(phone.open(undefined, { url: 'intent://evil' }), /Only http and https/);
  await assert.rejects(phone.open(undefined, { package: 'rm -rf /' }), /package name/);
  await assert.rejects(phone.tap('R58N123', 1, 1), (error: unknown) => error instanceof WorkforceError && /accept the debugging prompt/.test(error.message));
});

test('device selection: none, several, and missing adb give clear errors', async () => {
  const none = fakeAdb([(args) => (args[0] === 'devices' ? { stdout: Buffer.from('List of devices attached\n\n') } : undefined)]);
  await assert.rejects(none.phone.key(undefined, 'home'), /No Android phone is connected/);
  const two = fakeAdb([(args) => (args[0] === 'devices' ? { stdout: Buffer.from('List of devices attached\nA device model:One\nB device model:Two\n') } : undefined)]);
  await assert.rejects(two.phone.key(undefined, 'home'), /Several phones are connected \(A One, B Two\)/);
  await two.phone.key('B', 'home');
  assert.deepEqual(two.calls.at(-1)!.slice(1), ['-s', 'B', 'shell', 'input', 'keyevent', 'KEYCODE_HOME']);
  const missing = new AdbPhone({ log: new MemoryLogger(), exec: async () => ({ code: 0, stdout: new Uint8Array(), stderr: '' }), finder: { find: async () => null }, env: {}, platform: 'linux', home: '/home/x', exists: () => false });
  assert.equal(await missing.available(), false);
  await assert.rejects(missing.devices(), /adb \(Android platform tools\) is not installed/);
  const offline = fakeAdb([(args) => (args.includes('keyevent') ? { code: 1, stderr: 'error: device offline' } : undefined)]);
  await assert.rejects(offline.phone.key(undefined, 'home'), /not reachable/);
  assert.deepEqual(sdkCandidates({ ANDROID_HOME: 'C:\\Android' }, 'win32', 'C:\\Users\\me')[0], 'C:\\Android\\platform-tools\\adb.exe');
});

test('screenshots come from exec-out screencap and are downscaled; the UI tree is dumped to a private path', async () => {
  const tall = { width: 1080, height: 2400, channels: 3 as const, pixels: new Uint8Array(1080 * 2400 * 3).fill(200) };
  const png = encodePng(tall);
  const { phone, calls } = fakeAdb([
    (args) => (args.includes('screencap') ? { stdout: png } : undefined),
    (args) => (args.includes('uiautomator') ? { stdout: Buffer.from('UI hierchary dumped to: /data/local/tmp/workforce-ui.xml') } : undefined),
    (args) => (args.includes('cat') ? { stdout: Buffer.from(DUMP) } : undefined),
  ]);
  const shot = await phone.screenshot();
  assert.deepEqual(calls.at(-1)!.slice(1), ['-s', '192.168.1.20:37099', 'exec-out', 'screencap', '-p']);
  assert.deepEqual(pngSize(shot.data), { width: 720, height: 1600 });
  assert.equal(shot.scale, 1.5);
  assert.deepEqual(shot.screen, { width: 1080, height: 2400 });
  const tree = await phone.uiTree();
  assert.equal(tree.count, 3);
  assert.ok(calls.some((call) => call.join(' ').endsWith('shell uiautomator dump /data/local/tmp/workforce-ui.xml')));
  await phone.tap(undefined, 1079, 2399); // size known from the dump: no extra wm size call
  assert.equal(calls.some((call) => call.includes('wm')), false);
  const black = fakeAdb([(args) => (args.includes('screencap') ? { stdout: Buffer.from('not a png') } : undefined)]);
  await assert.rejects(black.phone.screenshot(), /returned no screenshot/);
});

test('adb runs as a supervised lease; output that arrives after the exit event is still read', async () => {
  const fake = fakeSpawn((call) => {
    setImmediate(() => {
      // Node may report 'exit' before the last stdout chunks of a large answer were read.
      call.child.exitCode = 0;
      call.child.emit('exit', 0, null);
      setTimeout(() => { call.child.stdout.write(Buffer.from(DEVICES)); call.child.stdout.end(); }, 15);
    });
  });
  const phone = new AdbPhone({ supervisor: testSupervisor(fake.spawn), log: new MemoryLogger(), finder: { find: async () => ({ command: 'C:\sdk\adb.exe', prefixArgs: [], path: 'C:\sdk\adb.exe' }) } });
  const devices = await phone.devices();
  assert.deepEqual(devices.map((device) => device.serial), ['192.168.1.20:37099', 'R58N123']);
  assert.equal(fake.calls[0].command, 'C:\sdk\adb.exe');
  assert.deepEqual(fake.calls[0].args, ['devices', '-l']);
  assert.deepEqual(fake.calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);
});
