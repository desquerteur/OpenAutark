// B-078 port mapping of the peer listener (http/portmap.ts): NAT-PMP's messages, a router behind another NAT (private or
// carrier-grade outside address) advertises nothing, UPnP-IGD's description and SOAP calls when NAT-PMP is silent, and
// the keeper renews at half the lease and removes the mapping on stop. Fake UDP and fetch; no router is touched.
// Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:dgram';
import { guessGateways, pmpAnswer, pmpRequest, PortKeeper, PortMap, RENEW_RETRY_S, unreachableIp, wanService } from '../../../src/runtime/http/portmap.ts';
import { silentLog } from '../devices/fakes.ts';

/** A UDP socket whose router answers NAT-PMP with `outside` (undefined: silent). */
function router(outside: string | undefined, sent: Buffer[] = []): () => Socket {
  return () => {
    const socket = new EventEmitter() as EventEmitter & { send: unknown; close: () => void; unref: () => void };
    socket.send = (message: Buffer, _port: number, _host: string, done: (error?: Error) => void) => {
      sent.push(Buffer.from(message));
      done();
      if (!outside || message.length === 0) return;
      const answer = message[1] === 0
        ? Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, ...outside.split('.').map(Number)])
        : (() => { const out = Buffer.alloc(16); out[1] = 130; out.writeUInt16BE(message.readUInt16BE(4), 8); out.writeUInt16BE(message.readUInt16BE(6), 10); out.writeUInt32BE(message.readUInt32BE(8), 12); return out; })();
      setImmediate(() => socket.emit('message', answer));
    };
    socket.close = () => undefined;
    socket.unref = () => undefined;
    return socket as unknown as Socket;
  };
}

test('NAT-PMP messages: the outside address request, a TCP mapping with its lease, and their answers', () => {
  assert.deepEqual([...pmpRequest(0)], [0, 0]);
  const map = pmpRequest(2, 47812, 3600);
  assert.deepEqual([map[0], map[1], map.readUInt16BE(4), map.readUInt16BE(6), map.readUInt32BE(8)], [0, 2, 47812, 47812, 3600]);
  assert.deepEqual(pmpAnswer(Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 198, 51, 100, 7])), { ip: '198.51.100.7' });
  assert.equal(pmpAnswer(Buffer.from([0, 128, 0, 3, 0, 0, 0, 1, 198, 51, 100, 7])), undefined, 'a result code ≠ 0 is no answer');
  assert.ok(unreachableIp('100.72.1.1') && unreachableIp('192.168.0.2') && unreachableIp('10.1.2.3') && unreachableIp('172.20.0.1'));
  assert.equal(unreachableIp('198.51.100.7'), false);
  assert.deepEqual(guessGateways({ wifi: [{ address: '192.168.1.37', netmask: '255.255.255.0', family: 'IPv4', internal: false } as never] }), ['192.168.1.1']);
});

test('NAT-PMP maps the port at the router; a router behind another NAT advertises nothing; removing asks for lease 0', async () => {
  const sent: Buffer[] = [];
  const map = new PortMap({ log: () => silentLog, gateways: () => ['192.168.1.1'], udp: router('198.51.100.7', sent), lease: 600 });
  const mapped = await map.map(47812);
  assert.equal(mapped?.url, 'http://198.51.100.7:47812');
  assert.equal(mapped?.via, 'nat-pmp');
  assert.equal(mapped?.lease, 600);
  await mapped!.remove();
  assert.equal(sent.at(-1)!.readUInt32BE(8), 0, 'lease 0 removes it');

  const cgnat = new PortMap({ log: () => silentLog, gateways: () => ['192.168.1.1'], udp: router('100.80.3.4'), fetch: async () => { throw new Error('no UPnP'); } });
  assert.equal(await cgnat.map(47812), undefined);
});

test('UPnP-IGD when NAT-PMP is silent: the WAN service from the description, the outside address, AddPortMapping, DeletePortMapping', async () => {
  const description = `<root><URLBase>http://192.168.1.1:5000/</URLBase><device><serviceList>
    <service><serviceType>urn:schemas-upnp-org:service:Layer3Forwarding:1</serviceType><controlURL>/l3f</controlURL></service>
    <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
  </serviceList></device></root>`;
  assert.deepEqual(wanService(description, 'http://192.168.1.1:5000/rootDesc.xml'), { type: 'urn:schemas-upnp-org:service:WANIPConnection:1', control: 'http://192.168.1.1:5000/ctl/IPConn' });
  const actions: string[] = [];
  const fetch = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    if (!init?.headers) return new Response(description);
    const action = init.headers.SOAPAction.split('#')[1].replace('"', '');
    actions.push(action);
    return new Response(action === 'GetExternalIPAddress' ? '<NewExternalIPAddress>203.0.113.9</NewExternalIPAddress>' : '<ok/>');
  }) as unknown as typeof globalThis.fetch;
  const ssdp = (): Socket => {
    const socket = new EventEmitter() as EventEmitter & { send: unknown; close: () => void; unref: () => void };
    socket.send = (message: Buffer, port: number, _host: string, done: () => void) => {
      done();
      if (port === 1900) setImmediate(() => socket.emit('message', Buffer.from('HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n')));
    };
    socket.close = () => undefined;
    socket.unref = () => undefined;
    return socket as unknown as Socket;
  };
  const map = new PortMap({ log: () => silentLog, gateways: () => [], udp: ssdp, fetch, interfaces: () => ({ wifi: [{ address: '192.168.1.37', netmask: '255.255.255.0', family: 'IPv4', internal: false } as never] }) });
  const mapped = await map.map(47812);
  assert.equal(mapped?.url, 'http://203.0.113.9:47812');
  assert.equal(mapped?.via, 'upnp');
  await mapped!.remove();
  assert.deepEqual(actions, ['GetExternalIPAddress', 'AddPortMapping', 'DeletePortMapping']);
});

test('the keeper tells the URL, renews by its lease and removes the mapping on stop', async () => {
  const urls: Array<string | undefined> = [];
  let maps = 0;
  let removed = 0;
  const keeper = new PortKeeper({ map: async (port) => { maps++; return { url: `http://198.51.100.7:${port}`, via: 'nat-pmp', lease: 3600, remove: async () => { removed++; } }; } }, (url) => urls.push(url));
  await keeper.start(47812);
  await keeper.start(47812);
  assert.equal(maps, 1, 'the same port stays mapped');
  assert.equal(keeper.url(), 'http://198.51.100.7:47812');
  await keeper.stop();
  assert.deepEqual(urls, ['http://198.51.100.7:47812', undefined]);
  assert.equal(removed, 1);
  assert.equal(keeper.url(), undefined);
});

test('UPnP takes an SSDP answer only from a router address, and a control URL only on that host', async () => {
  const interfaces = () => ({ wifi: [{ address: '192.168.1.37', netmask: '255.255.255.0', family: 'IPv4', internal: false } as never] });
  const fetched: string[] = [];
  const answering = (location: string, control: string) => {
    const fetch = (async (url: string) => { fetched.push(url); return new Response(`<root><service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>${control}</controlURL></service></root>`); }) as unknown as typeof globalThis.fetch;
    const udp = (): Socket => {
      const socket = new EventEmitter() as EventEmitter & { send: unknown; close: () => void; unref: () => void };
      socket.send = (_message: Buffer, port: number, _host: string, done: () => void) => { done(); if (port === 1900) setImmediate(() => socket.emit('message', Buffer.from(`HTTP/1.1 200 OK\r\nLOCATION: ${location}\r\n\r\n`))); };
      socket.close = () => undefined;
      socket.unref = () => undefined;
      return socket as unknown as Socket;
    };
    return new PortMap({ log: () => silentLog, gateways: () => [], udp, fetch, interfaces });
  };
  assert.equal(await answering('http://192.168.1.50/desc.xml', '/ctl').map(47812), undefined, 'a rogue LAN device');
  assert.deepEqual(fetched, [], 'its description is not even fetched');
  assert.equal(await answering('http://192.168.1.1:5000/desc.xml', 'http://192.168.1.60/ctl').map(47812), undefined, 'a control URL on another host');
  assert.deepEqual(fetched, ['http://192.168.1.1:5000/desc.xml'], 'no SOAP to the other host');
});

test('a renewal the router does not answer is tried again on the one timer, and the URL comes back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const urls: Array<string | undefined> = [];
  const answers = [true, false, false, true];
  let maps = 0;
  const keeper = new PortKeeper({ map: async (port) => (answers[maps++] ? { url: `http://198.51.100.7:${port}`, via: 'nat-pmp', lease: 120, remove: async () => {} } : undefined) }, (url) => urls.push(url));
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  await keeper.start(47812);
  t.mock.timers.tick(60_000); await flush();
  assert.equal(maps, 2, 'renewed at half the lease');
  assert.equal(keeper.url(), undefined);
  t.mock.timers.tick(RENEW_RETRY_S[0] * 1000); await flush();
  assert.equal(maps, 3, 'first retry');
  t.mock.timers.tick(RENEW_RETRY_S[1] * 1000); await flush();
  assert.equal(maps, 4, 'second retry');
  assert.equal(keeper.url(), 'http://198.51.100.7:47812');
  assert.deepEqual(urls, ['http://198.51.100.7:47812', undefined, 'http://198.51.100.7:47812']);
  await keeper.stop();
  const none = new PortKeeper({ map: async () => { maps++; return undefined; } }, () => {});
  const before = maps;
  await none.start(1);
  t.mock.timers.tick(3_600_000); await flush();
  assert.equal(maps, before + 1, 'no router at all: no retries');
});
