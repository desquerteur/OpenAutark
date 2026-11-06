// The phone's link to its PC (src/ui/workspace/phone-tabs.ts watchPhoneTabs with pages.ts, B-076): a blank tab shown
// on the PC (its space names no shown tab) leaves the phone's shown tab as it is, and nothing goes back that would pull
// the PC's blank tab away; a tab change made while the connection is down sends nothing, and the read on reconnect
// brings the PC's newer tabs, from which the next change starts.
// Owns: these assertions only. Never: a real PC, a socket or a window.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PaneTabs } from '../../../src/shared/api/methods-tabs.ts';
import type { SessionInfo } from '../../../src/shared/api/methods.ts';
import type { SideSpaces } from '../../../src/shared/api/workspace-browser.ts';
import { rpc } from '../../../src/ui/lib/rpc.ts';
import { session } from '../../../src/ui/lib/session.ts';
import * as pages from '../../../src/ui/workspace/pages.ts';
import { watchPhoneTabs } from '../../../src/ui/workspace/phone-tabs.ts';

const web1 = { id: 'remote:dev_pc:web-1', panel: 'remote', device: 'dev_pc', tab: 'web-1', url: 'https://one.example/' };
const day = { id: 'day', panel: 'day' };
let pc: SideSpaces = { global: { shown: web1.id, tabs: [web1, day] } };
const sets: Array<{ spaces: SideSpaces; closed: string[] }> = [];
const heard = new Map<string, (data: unknown) => void>();
const opened: Array<() => void> = [];
Object.assign(rpc, {
  call: async (method: string, params?: unknown) => {
    if (method === 'tabs.get') return { device: 'dev_pc', spaces: structuredClone(pc) } satisfies PaneTabs;
    if (method === 'tabs.set') sets.push(params as { spaces: SideSpaces; closed: string[] });
    return { ok: true };
  },
  on: (event: string, fn: (data: unknown) => void) => { heard.set(event, fn); return () => undefined; },
  onOpen: (fn: () => void) => { opened.push(fn); return () => undefined; },
});
rpc.status.value = 'open';
session.value = { kind: 'owner', capabilities: [], secure: true, allowedMethods: [] } as unknown as SessionInfo;
const settle = () => new Promise((resolve) => setImmediate(resolve));
const pcChanged = (spaces: SideSpaces) => heard.get('tabs.changed')!({ device: 'dev_pc', spaces: structuredClone(spaces) });

test('a blank tab shown on the PC leaves the phone\'s shown tab, and the phone sends nothing back', async () => {
  watchPhoneTabs();
  await settle();
  assert.equal(pages.shownOf('global'), web1.id);
  pc = { global: { tabs: [web1, day] } }; // Ctrl+T on the PC: its blank tab is shown, the file names none
  pcChanged(pc);
  await settle();
  assert.equal(pages.shownOf('global'), web1.id, 'the phone stays where it is');
  assert.equal(sets.length, 0, 'and sends nothing that would pull the PC\'s blank tab away');
  pages.selectPage('day');
  assert.equal(sets.length, 1);
  assert.equal(sets[0]!.spaces.global?.shown, 'day', 'a tab the person chooses here still goes');
});

test('a tab change while the connection is down sends nothing; the reconnect brings the PC\'s newer tabs', async () => {
  const before = sets.length;
  rpc.status.value = 'closed';
  pages.selectPage(pages.shownOf('global') === 'day' ? web1.id : 'day'); // another tab, tapped while the phone is offline
  assert.equal(sets.length, before, 'nothing waits to be replayed as a stale whole space');
  const file = { id: 'file:/srv/new.md', panel: 'file', path: '/srv/new.md' };
  const other = { id: 'remote:dev_b:web-9', panel: 'remote', device: 'dev_b', tab: 'web-9', url: 'https://b.example/' };
  pc = { global: { shown: file.id, tabs: [web1, day, file, other] } }; // meanwhile on the PC
  rpc.status.value = 'open';
  for (const read of opened) read();
  await settle();
  assert.equal(sets.length, before, 'the reconnect sends nothing either');
  assert.deepEqual(pages.tabsOf('global').map((tab) => tab.id), [web1.id, 'day', file.id, other.id]);
  assert.equal(pages.shownOf('global'), file.id);
  pages.selectPage('day');
  assert.equal(sets.length, before + 1);
  assert.deepEqual(sets.at(-1)!.spaces.global?.tabs.map((tab) => tab.id), [web1.id, 'day', file.id, other.id], 'the next change starts from the PC\'s newer tabs');
  assert.deepEqual(sets.at(-1)!.closed, []);
});
