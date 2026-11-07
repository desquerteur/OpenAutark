// Handler table completeness (R3-S1): every method in src/shared/api/methods.ts (or in a shared
// file augmenting its Methods) is registered exactly once by the handler modules,
// and the S1 modules cover their method groups.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHandlerTable } from '../../../src/runtime/rpc/handlers/index.ts';
import { allowedScope, HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register as portability } from '../../../src/runtime/rpc/handlers/portability.ts';
import { register as taskCenter } from '../../../src/runtime/rpc/handlers/task-center.ts';
import { register as agentCore } from '../../../src/runtime/rpc/handlers/agent-core.ts';
import { register as providers } from '../../../src/runtime/rpc/handlers/providers.ts';
import { register as chatFiles } from '../../../src/runtime/rpc/handlers/chat-files.ts';
import { register as filesPath } from '../../../src/runtime/rpc/handlers/files-path.ts';
import { register as skillLinks } from '../../../src/runtime/rpc/handlers/skill-links.ts';
import type { ClientScope, DeviceCapability } from '../../../src/shared/api/protocol.ts';
import { s1Table } from './s1-helpers.ts';

const METHODS_FILE = path.resolve(import.meta.dirname, '../../../src/shared/api/methods.ts');
const S1_GROUPS = ['system', 'events', 'settings', 'ui', 'spaces', 'agents', 'runs', 'chats', 'messages', 'blocks', 'tasks', 'todos', 'schedules', 'knowledge', 'skills', 'modes', 'files'];

const SHARED_DIR = path.resolve(import.meta.dirname, '../../../src/shared');
/** A module augmentation of Methods in another shared file (methods.ts is at its size limit – O5). */
const AUGMENTATION = /^declare module '[^']*api\/methods\.ts' \{([\s\S]*?)^\}/m;

/** Method names of methods.ts and of every shared file that augments its Methods. */
function contractMethods(): string[] {
  const sources = [readFileSync(METHODS_FILE, 'utf8')];
  for (const name of readdirSync(SHARED_DIR, { recursive: true, encoding: 'utf8' })) {
    if (!name.endsWith('.ts')) continue;
    const block = AUGMENTATION.exec(readFileSync(path.join(SHARED_DIR, name), 'utf8'));
    if (block) sources.push(block[1]);
  }
  return sources.flatMap((source) => [...source.matchAll(/^\s+'([a-z][A-Za-z]*\.[A-Za-z]+)':\s*\{/gm)].map((match) => match[1])).sort();
}

/** Methods of the S1 groups that live in other modules (agents.export and system.backup/restore: portability.ts). */
function portabilityMethods(): Set<string> {
  const table = new HandlerTable();
  portability(table);
  taskCenter(table); // tasks.quickCreate / tasks.route
  agentCore(table); // agents.core/saveMainSkill/setHome/openHome live with the agent core folders
  providers(table);
  chatFiles(table); // chats.direct/export live with the default 1:1 and the chat folders
  filesPath(table); // files.readPath/writePath/listPath live with the pane's file tab
  skillLinks(table); // AF-007: skills.previewLink/installLink/linked/checkUpdate/applyUpdate/linkTargets live with the links
  return new Set(table.methods());
}

test('S1 modules register every method of their groups', () => {
  const r4 = portabilityMethods();
  const mine = contractMethods().filter((method) => S1_GROUPS.includes(method.split('.')[0]) && !r4.has(method));
  assert.deepEqual(s1Table().methods(), mine);
});

test('createHandlerTable registers the whole contract exactly once', () => {
  const table = createHandlerTable(); // throws on duplicates
  assert.deepEqual(table.methods(), contractMethods());
});

test('device scope rules follow the capability matrix', () => {
  const table = createHandlerTable();
  const device = (capabilities: DeviceCapability[]): ClientScope => ({ kind: 'device', deviceId: 'dev_x', capabilities, secure: true });
  const may = (method: string, scope: ClientScope) => allowedScope(table.get(method)!.scope, scope);
  const todo = device(['todo']);
  for (const method of ['todos.list', 'todos.add', 'todos.changeWidget', 'tasks.complete', 'blocks.answer', 'blocks.state', 'blocks.event',
    'files.upload', 'files.uploadChunk', 'files.get', 'files.read', 'events.subscribe', 'events.unsubscribe', 'system.info', 'settings.get', 'agents.list', 'ui.state']) {
    assert.ok(may(method, todo), `${method} for 'todo'`);
  }
  for (const method of ['chats.list', 'messages.send', 'tasks.list', 'agents.get', 'files.uploadPath', 'files.open', 'files.openPath', 'settings.update', 'knowledge.list', 'blocks.sandboxUrl', 'spaces.list', 'modes.list']) {
    assert.ok(!may(method, todo), `${method} not for 'todo'`);
  }
  const chat = device(['todo', 'chat']);
  for (const method of ['chats.list', 'chats.get', 'chats.create', 'chats.markRead', 'chats.search', 'messages.list', 'messages.send', 'messages.stop',
    'messages.retry', 'messages.schedule', 'blocks.appHtml', 'blocks.sandboxUrl', 'agents.get', 'agents.activity',
    // DEV2: the chat tier also renames/pins/archives, changes members, edits own messages and reads org/knowledge/skills/modes.
    'chats.update', 'chats.archive', 'chats.members', 'messages.edit', 'messages.delete', 'spaces.list', 'agents.org', 'agents.templates',
    'knowledge.search', 'knowledge.list', 'knowledge.save', 'knowledge.expire', 'knowledge.history', 'skills.list', 'skills.get', 'modes.list',
    'runs.items' /* C5 */]) {
    assert.ok(may(method, chat), `${method} for 'chat'`);
  }
  for (const method of ['chats.delete', 'skills.delete', 'skills.save', 'agents.create', 'spaces.save']) {
    assert.ok(!may(method, chat), `${method} not for 'chat'`);
  }
  const tasks = device(['todo', 'tasks']);
  for (const method of ['tasks.list', 'tasks.get', 'tasks.create', 'tasks.update', 'tasks.setStatus', 'tasks.reorder', 'tasks.delete', 'tasks.share', 'schedules.list']) {
    assert.ok(may(method, tasks), `${method} for 'tasks'`);
  }
  for (const method of ['schedules.update', 'schedules.delete', 'schedules.runNow', 'runs.items', 'runs.cancel', 'agents.update', 'spaces.save', 'system.resources']) {
    assert.ok(!may(method, tasks), `${method} not for 'tasks'`);
  }
  assert.ok(may('settings.update', device(['settings'])));
  const manage = device(['manage']);
  for (const method of ['schedules.update', 'schedules.delete', 'schedules.runNow', 'runs.cancel', 'agents.runs', 'agents.create', 'agents.update',
    'agents.archive', 'spaces.save', 'spaces.archive', 'skills.save']) {
    assert.ok(may(method, manage), `${method} for 'manage'`);
  }
  for (const method of ['system.resources', 'skills.delete', 'chats.delete', 'files.open']) {
    assert.ok(!may(method, device(['todo', 'chat', 'tasks', 'settings', 'manage', 'permissions'])), `${method} owner-only`);
  }
});
