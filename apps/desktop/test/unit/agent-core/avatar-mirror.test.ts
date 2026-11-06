// B-044 image avatar mirror (agent-core/avatar.ts): an agent with an image avatar has its bytes as
// <data>/agents/<id>/avatar.png (avatar.jpg for a JPEG) – written at start and when the avatar changes
// (or its copy is gone), not again on status-only updates, removed when the avatar is no image; no folder, no file.
// Owns: these assertions only. Never: the agent core service, timers or polling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { AvatarMirror } from '../../../src/runtime/agent-core/avatar.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import type { FileRef } from '../../../src/shared/model/system.ts';
import { recordingBus, tempDir } from '../store/helpers.ts';

function rig() {
  const temp = tempDir('wf-avatar-');
  const blobs = path.join(temp.dir, 'blobs');
  mkdirSync(blobs, { recursive: true });
  const refs = new Map<string, FileRef>();
  let copies = 0;
  const blob = (char: string, mime: string, bytes: string) => {
    const id = char.repeat(64);
    writeFileSync(path.join(blobs, id), bytes);
    refs.set(id, { id, name: 'portrait', mime, size: bytes.length, createdAt: 0 });
    return id;
  };
  const agents: Array<Pick<Agent, 'id' | 'avatar'>> = [{ id: 'ag_ada', avatar: { kind: 'initials', value: 'A' } }];
  mkdirSync(path.join(temp.dir, 'agents', 'ag_ada'), { recursive: true });
  const { bus } = recordingBus();
  const mirror = new AvatarMirror({
    dataDir: temp.dir, bus, log: { debug() {}, info() {}, warn() {}, error() {} },
    files: { get: (id) => refs.get(id), path: (id) => { copies++; return path.join(blobs, id); } },
    org: () => ({ list: () => agents as Agent[] }),
  });
  const file = (name: string) => path.join(temp.dir, 'agents', 'ag_ada', name);
  return { temp, bus, blob, agents, mirror, file, copies: () => copies };
}

test('the image avatar is copied beside SYSTEM.md, follows changes and goes with the image', () => {
  const r = rig();
  try {
    const png = r.blob('a', 'image/png', 'PNGDATA');
    r.agents[0].avatar = { kind: 'image', value: png };
    r.mirror.start();
    assert.equal(readFileSync(r.file('avatar.png'), 'utf8'), 'PNGDATA');
    assert.equal(r.copies(), 1);
    r.bus.emit('agent.upserted', { ...r.agents[0], status: 'working' } as Agent);
    assert.equal(r.copies(), 1, 'a status update copies nothing');

    const jpeg = r.blob('b', 'image/jpeg', 'JPEGDATA');
    r.bus.emit('agent.upserted', { id: 'ag_ada', avatar: { kind: 'image', value: jpeg } } as Agent);
    assert.equal(readFileSync(r.file('avatar.jpg'), 'utf8'), 'JPEGDATA');
    assert.equal(existsSync(r.file('avatar.png')), false, 'one copy per agent');

    r.bus.emit('agent.upserted', { id: 'ag_ada', avatar: { kind: 'emoji', value: '🎬' } } as Agent);
    assert.equal(existsSync(r.file('avatar.jpg')), false);
    r.mirror.stop();
  } finally { r.temp.cleanup(); }
});

test('a copy deleted by hand comes back on the next update; an agent without a folder gets none', () => {
  const r = rig();
  try {
    const png = r.blob('c', 'image/png', 'P');
    r.agents[0].avatar = { kind: 'image', value: png };
    r.mirror.start();
    r.mirror.sync({ id: 'ag_new', avatar: { kind: 'image', value: png } });
    assert.equal(existsSync(path.join(r.temp.dir, 'agents', 'ag_new')), false, 'never creates an agent folder');
    rmSync(r.file('avatar.png'));
    r.bus.emit('agent.upserted', { ...r.agents[0], status: 'idle' } as Agent);
    assert.equal(readFileSync(r.file('avatar.png'), 'utf8'), 'P');
    r.mirror.stop();
  } finally { r.temp.cleanup(); }
});
