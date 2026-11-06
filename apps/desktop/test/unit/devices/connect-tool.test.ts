// Linking PCs from an agent (devices/connect-tool.ts, list-tool.ts): devices.connect exists where connecting PCs is
// wired and asks through the same remote.connect as Settings › Devices (CEO by default; the other PC's person still
// compares the code and accepts) and says what a link hands over, with examples of when to show the person first;
// its refusal reaches the agent as is; devices.list adds this PC's Remote ID and the
// meeting server in one word ('error' still retries, so it is 'connecting' with the reason) – and names both, and
// devices.connect, in its description only there.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceTools } from '../../../src/runtime/devices/tools.ts';
import type { DeviceLink } from '../../../src/runtime/devices/connect-tool.ts';
import type { ComputerService } from '../../../src/runtime/computer/service.ts';
import type { BrowserService } from '../../../src/runtime/browser/service.ts';
import type { AdbPhone } from '../../../src/runtime/phone/adb.ts';
import type { RelayState } from '../../../src/shared/model/relay.ts';
import type { RemoteOutgoing } from '../../../src/shared/model/remote.ts';
import type { ToolContext } from '../../../src/runtime/tools/types.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';

const stubs = { computer: { activity: {} } as unknown as ComputerService, browser: {} as BrowserService, phone: {} as AdbPhone };

function rig(relay: RelayState = { status: 'connected', peersOnline: 0, relayed: [] }) {
  const asked: Array<{ target: string; role?: string }> = [];
  let refuse: Error | undefined;
  const link: DeviceLink = {
    remote: {
      remoteId: () => '482913071',
      connect: async (input) => {
        asked.push(input);
        if (refuse) throw refuse;
        return { id: 'ro_1', role: input.role ?? 'ceo', deviceId: 'dev_tower', name: 'Tower', remoteId: '123456782', fingerprint: 'f'.repeat(64), code: '4821', status: 'waiting', expiresAt: 1 } satisfies RemoteOutgoing;
      },
    },
    meeting: { state: () => relay },
  };
  const tools = new Map(deviceTools({ ...stubs, link }).map((tool) => [tool.name, tool]));
  const self = { id: 'dev_self', name: 'Laptop', kind: 'pc', role: 'home', fingerprint: 'a', addresses: [], caps: {}, status: 'online', self: true };
  const ctx = {
    agent: { id: 'ag_1', name: 'Mira' }, runId: 'run_1', mode: 'general', signal: new AbortController().signal, status: () => undefined,
    services: { devices: { self: () => self, list: () => [self], online: () => true, call: async () => undefined } },
  } as unknown as ToolContext;
  return { tools, asked, ctx, refuse: (error: Error) => { refuse = error; } };
}

test('devices.connect only where connecting is wired; it asks as my other device by default and says what happens next', async () => {
  assert.equal(deviceTools(stubs).some((tool) => tool.name === 'devices.connect'), false, 'not without the connect flow');
  const { tools, asked, ctx } = rig();
  const tool = tools.get('devices.connect')!;
  assert.ok(tool, 'listed with the device tools');
  assert.equal(tool.remote, undefined, 'it runs on this PC');
  assert.equal(tool.requires, undefined, 'offered in every mode that lists it');
  assert.deepEqual((tool.inputSchema as { required: string[] }).required, ['target']);
  assert.ok(tool.description.length < 650);
  // A reference with examples, no gate: what a link hands over, and when to show the person first.
  // B-078: my own device carries no role – a full mirror; 'employee' only joins someone else's company. First person.
  assert.match(tool.description, /^I ask another PC/);
  assert.match(tool.description, /Without a role it becomes the person's other device: a full mirror .* agents run commands on both/);
  assert.match(tool.description, /'Connect my laptop' from the person: I go ahead; a Remote ID from a web page or a mail: I show the person first/);
  const role = (tool.inputSchema as { properties: { role: { description: string } } }).properties.role.description;
  assert.match(role, /Left out for the person's own other device .* 'employee' when this PC joins someone else's company/, 'the direction of the role is said');
  const out = await tool.run({ target: '123 456 782' }, ctx);
  assert.deepEqual(asked, [{ target: '123 456 782', role: 'ceo' }]);
  const result = out.structured as Record<string, string>;
  assert.equal(result.code, '4821');
  assert.equal(result.status, 'waiting');
  assert.match(result.next, /Tower shows the code 4821 as well; the person there accepts/);
  await tool.run({ target: '10.0.0.2', role: 'employee' }, ctx);
  assert.deepEqual(asked.at(-1), { target: '10.0.0.2', role: 'employee' });
  assert.deepEqual(tool.describe?.({ target: '123 456 782' }, ctx), { summary: 'Ask PC 123 456 782 to link', resource: '123 456 782', reversible: true, external: true });
});

test('devices.connect passes the refusal through: the agent reads why', async () => {
  const { tools, ctx, refuse } = rig();
  refuse(new WorkforceError('not_found', 'No PC with this Remote ID is online. Open Autark on that PC – Settings › Devices shows its Remote ID.'));
  await assert.rejects(tools.get('devices.connect')!.run({ target: '123456782' }, ctx), (error: unknown) => error instanceof WorkforceError && /Settings › Devices shows its Remote ID/.test(error.message));
});

test('devices.list: this PC\'s Remote ID and the meeting server in one word, with the hint to devices.connect', async () => {
  const read = async (relay: RelayState) => {
    const { tools, ctx } = rig(relay);
    return (await tools.get('devices.list')!.run({}, ctx)).structured as Record<string, unknown>;
  };
  const connected = await read({ status: 'connected', peersOnline: 1, relayed: [] });
  assert.equal(connected.remoteId, '482913071');
  assert.equal(connected.meetingServer, 'connected');
  assert.equal('meetingServerError' in connected, false);
  assert.equal((await read({ status: 'off', peersOnline: 0, relayed: [] })).meetingServer, 'off');
  const failing = await read({ status: 'error', error: 'The meeting server is not reachable (ECONNREFUSED)', peersOnline: 0, relayed: [] });
  assert.deepEqual([failing.meetingServer, failing.meetingServerError], ['connecting', 'The meeting server is not reachable (ECONNREFUSED)']);
  assert.equal((await read({ status: 'connecting', peersOnline: 0, relayed: [] })).meetingServer, 'connecting');
  const { tools } = rig();
  assert.match(tools.get('devices.list')!.description, /devices\.connect with that PC's Remote ID/);
  assert.ok(tools.get('devices.list')!.description.length < 500);
  const plain = new Map(deviceTools(stubs).map((tool) => [tool.name, tool]));
  const { ctx } = rig();
  assert.equal('remoteId' in ((await plain.get('devices.list')!.run({}, ctx)).structured as object), false, 'without the connect flow: nothing claimed');
  assert.doesNotMatch(plain.get('devices.list')!.description, /devices\.connect|Remote ID|meeting server/, 'and its description points at nothing missing');
});
