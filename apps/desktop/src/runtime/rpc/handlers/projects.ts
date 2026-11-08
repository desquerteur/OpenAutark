// RPC handlers (AF-018) of the Projects tab: list, get, add, update, remove and startSession. Owner only: projects are
// folders of this PC, and a session start can hire an agent for one. Owns: param checks. Never: business logic
// (runtime/projects).

import '../../../shared/api/methods-projects.ts'; // the method shapes (module augmentation)
import { HOME_MAX_CHARS } from '../../../shared/model/agent-core.ts';
import { projectsOf } from '../../projects/service.ts';
import { rememberConversation } from './system.ts';
import { input, onlyKeys, optBool, optId, optText, text } from '../params.ts';
import type { HandlerTable } from '../table.ts';

const MAX_PROMPT = 100_000;

export function register(table: HandlerTable): void {
  table.add('projects.list', (params, ctx) => {
    if (params !== undefined && params !== null) onlyKeys(input(params), []);
    return projectsOf(ctx.services).list();
  }, 'owner');
  table.add('projects.get', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return projectsOf(ctx.services).get(text(o, 'id', { max: 64 }));
  }, 'owner');
  table.add('projects.add', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['folder', 'name']);
    return projectsOf(ctx.services).add(text(o, 'folder', { max: HOME_MAX_CHARS }), optText(o, 'name', { max: 80, allowEmpty: true }));
  }, 'owner');
  table.add('projects.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'name', 'pinned']);
    const name = optText(o, 'name', { max: 80, allowEmpty: true });
    const pinned = optBool(o, 'pinned');
    return projectsOf(ctx.services).update(text(o, 'id', { max: 64 }), { ...(name !== undefined ? { name } : {}), ...(pinned !== undefined ? { pinned } : {}) });
  }, 'owner');
  table.add('projects.remove', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id']);
    return projectsOf(ctx.services).remove(text(o, 'id', { max: 64 }));
  }, 'owner');
  table.add('projects.startSession', async (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['projectId', 'prompt', 'agentId', 'title']);
    const agentId = optId(o, 'agentId');
    const title = optText(o, 'title', { max: 120, allowEmpty: true });
    const result = await projectsOf(ctx.services).startSession({
      projectId: text(o, 'projectId', { max: 64 }),
      prompt: text(o, 'prompt', { max: MAX_PROMPT, multiline: true }),
      ...(agentId ? { agentId } : {}),
      ...(title ? { title } : {}),
    });
    rememberConversation(ctx.services, result.conversation.id);
    return result;
  }, 'owner');
}
