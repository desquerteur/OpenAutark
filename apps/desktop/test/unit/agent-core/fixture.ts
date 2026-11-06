// Fixture for the agent core tests (wave 3): a real Org on a migrated in-memory database, a real
// SkillLibrary with the Main Skills roots in a temp data folder (no home roots), VersionedSkills, and
// an AgentCore whose follow-ups are collected (runDeferred) instead of setImmediate. With a (fake) watch, a
// data folder watcher (runtime/root/watcher.ts, debounce 1 ms) on the temp data folder is started and given to it.
// B-044: home projects are judged by the temp folders (`paths`) with a person's home of its own (`guard`).
// Owns: fixtures only.

import { EventEmitter } from 'node:events';
import { mkdirSync, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { AgentCore, type AgentCoreDeps } from '../../../src/runtime/agent-core/service.ts';
import { mainSkillRoots, mainSkillsDir, systemFile } from '../../../src/runtime/agent-core/layout.ts';
import { RootWatcher, type WatchFn } from '../../../src/runtime/root/watcher.ts';
import { Org } from '../../../src/runtime/org/service.ts';
import { SkillLibrary } from '../../../src/runtime/skills/service.ts';
import { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { clock, memoryDb, recordingBus, RESOURCES, tempDir } from '../store/helpers.ts';

export function coreFixture(options: { watch?: WatchFn | false } = {}) {
  const temp = tempDir('wf-core-');
  const data = path.join(temp.dir, 'data');
  const workspace = path.join(temp.dir, 'workspace');
  const resources = path.join(temp.dir, 'resources');
  mkdirSync(path.join(resources, 'skills'), { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const paths = { data, workspace, resources, temp: path.join(temp.dir, 'tmp') };
  const db = memoryDb();
  const time = clock();
  const events = recordingBus();
  const log = new MemoryLogger();
  const org = new Org({ db, bus: events.bus, clock: time, templatesDir: path.join(RESOURCES, 'agents') });
  const library = new SkillLibrary({
    paths: { workspace, resources }, clock: time, home: '',
    mainRoots: () => mainSkillRoots(data, (id) => org.get(id) !== undefined), mainDir: (id) => mainSkillsDir(data, id),
  });
  const skills = library;
  const deferred: Array<() => void> = [];
  // recursive: the one tree watch on every system, so the fake sees one handle on <data> (root/watcher-folders.test.ts covers the other mode).
  const root = options.watch ? new RootWatcher({ root: data, clock: time, log, watch: options.watch, debounceMs: 1, recursive: true }) : undefined;
  root?.start();
  const deps: AgentCoreDeps = {
    dataDir: data, org: () => org, skills: () => library, bus: events.bus, clock: time, log,
    ...(root ? { root } : {}), defer: (run) => { deferred.push(run); },
    paths,
  };
  const core = new AgentCore(deps);
  return {
    temp, data, workspace, resources, paths, db, time, events, log, org, library, skills, core, deps, deferred, root,
    /** A second AgentCore on the same folders (a restart). */
    restart: () => new AgentCore(deps),
    runDeferred: () => { while (deferred.length) deferred.shift()!(); },
    file: (agentId: string) => systemFile(data, agentId),
    cleanup: () => { core.stop(); root?.stop(); temp.cleanup(); },
  };
}

/** A fake fs.watch: the test calls `fire(name)` as the OS would, `fail()` emits the watcher's 'error'. */
export function fakeWatch(): { watch: WatchFn; fire: (name: string | null) => void; fail: () => void; targets: string[] } {
  let listener: ((event: string, name: string | Buffer | null) => void) | undefined;
  let current: EventEmitter | undefined;
  const targets: string[] = [];
  const watch: WatchFn = (target, _options, onEvent) => {
    targets.push(target);
    listener = onEvent;
    current = Object.assign(new EventEmitter(), { close: () => { listener = undefined; } });
    return current as unknown as FSWatcher;
  };
  return { watch, targets, fire: (name) => listener?.('change', name), fail: () => current?.emit('error', new Error('EPERM: the folder went away')) };
}

export const skillMd = (name: string, description: string, body = 'Steps.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
