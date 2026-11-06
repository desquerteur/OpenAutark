// RPC handlers: spaces, agents (list/get/org tree/templates/hire/update/archive/restore), live
// activity, run audit (runs, items) and cancelling a run. agents.update also checks that an image
// avatar is a stored image and that 'Works on' names this PC (stored as none) or a linked PC (O6).
// Owns: param checks and scope rules for these methods. Never: business logic – it delegates
// to the org service, the dispatcher and the run journal. Agents hired here are createdBy 'human'.
// Tiers: reads with 'chat'; hiring, editing, archiving, spaces and run insight with 'manage'. runs.items is a
// 'chat' method for the runs of chats the device can open (the "Worked … · N steps" line under an
// answer, C5) and, B-054 P10, for chat-free runs whose task (if any) still exists; every other run's
// items need 'manage' (checkRunAccess).
// agents.archive takes an optional successorId (org/service.ts: the successor takes over role, place, reports, tasks).
// B-057: agents.runs lists the agent's own turns only (its splits' runs are under their groups, splits.list); runs.items
// judges a split's run as its group's parent run – the rule of splits.list/get (people/events.ts splitPlace).
// Wave 3: agents.update `base.instructions` = the text an editor started from; instructions changed meanwhile
// (SYSTEM.md taken over, another edit) refuse the edit as a conflict (root/text-doc.ts staleBase).

import { HUMAN_ID } from '../../../shared/ids.ts';
import type { Agent, Space } from '../../../shared/model/org.ts';
import type { Run } from '../../../shared/model/runs.ts';
import { WorkforceError } from '../../../shared/errors.ts';
import { id, input, notFound, num, onlyKeys, optBool, optId, optNum, optOneOf, optText, text } from '../params.ts';
import { scopeHas } from '../table.ts';
import { splitPlace } from '../../people/events.ts';
import { staleBase } from '../../root/text-doc.ts';
import { clearChatRetry } from '../../agents/redelivery.ts';
import type { HandlerContext, HandlerTable } from '../table.ts';

const TODO = { capability: 'todo' } as const;
const CHAT = { capability: 'chat' } as const;
const MANAGE = { capability: 'manage' } as const;
/** Who changes an agent through these methods – the person. */
const PERSON = { by: HUMAN_ID } as const;
const SPACE_KINDS = ['company', 'brand', 'private', 'custom'] as const;
/** Fields the human may change through agents.update (identity, org place, model policy). */
const AGENT_PATCH = ['name', 'role', 'avatar', 'instructions', 'mode', 'skills', 'modelPolicy', 'managerId', 'spaceId', 'team', 'deviceId', 'voice'] as const;

export function register(table: HandlerTable): void {
  // ---------------------------------------------------------------- spaces
  table.add('spaces.list', (_params, ctx) => ctx.services.org.spaces(), CHAT);
  table.add('spaces.save', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'name', 'kind', 'color', 'sort']);
    const space: Partial<Space> & { name: string } = { name: text(o, 'name', { max: 80 }) };
    const spaceId = optId(o, 'id');
    if (spaceId) space.id = spaceId;
    const kind = optOneOf(o, 'kind', SPACE_KINDS);
    if (kind) space.kind = kind;
    if (o.color === null) space.color = null as unknown as undefined; // null clears the color (org service)
    else if (o.color !== undefined) space.color = text(o, 'color', { max: 40 });
    const sort = optNum(o, 'sort', { min: -1_000_000, max: 1_000_000 });
    if (sort !== undefined) space.sort = sort;
    return ctx.services.org.saveSpace(space);
  }, MANAGE);
  table.add('spaces.archive', (params, ctx) => {
    ctx.services.org.archiveSpace(id(input(params)));
    return { ok: true };
  }, MANAGE);

  // ---------------------------------------------------------------- agents
  table.add('agents.list', (params, ctx) => ctx.services.org.list({ includeArchived: optBool(input(params), 'includeArchived') ?? false }), TODO);
  table.add('agents.get', (params, ctx) => ctx.services.org.require(id(input(params))), CHAT);
  table.add('agents.org', (_params, ctx) => ctx.services.org.tree(), CHAT);
  table.add('agents.templates', (_params, ctx) => ctx.services.org.templates(), CHAT);
  table.add('agents.create', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['name', 'template', 'role', 'managerId', 'spaceId', 'instructions', 'mode']);
    return ctx.services.org.create({
      name: optText(o, 'name', { max: 80 }),
      template: optText(o, 'template', { max: 80 }),
      role: optText(o, 'role', { max: 80, allowEmpty: true }),
      managerId: optId(o, 'managerId'),
      spaceId: optId(o, 'spaceId'),
      instructions: optText(o, 'instructions', { max: 20_000, allowEmpty: true, multiline: true }),
      mode: optText(o, 'mode', { max: 60 }),
      createdBy: HUMAN_ID,
    });
  }, MANAGE);
  table.add('agents.update', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'patch', 'base']);
    const agentId = id(o);
    const patch = input(o.patch);
    onlyKeys(patch, AGENT_PATCH, 'patch');
    const base = o.base === undefined ? undefined : input(o.base);
    if (base) onlyKeys(base, ['instructions'], 'base');
    const baseText = base ? optText(base, 'instructions', { max: 20_000, allowEmpty: true, multiline: true }) : undefined;
    if (baseText !== undefined && typeof patch.instructions === 'string' && staleBase(ctx.services.org.require(agentId).instructions, baseText, patch.instructions)) {
      throw new WorkforceError('conflict', 'The instructions changed while you were editing (in SYSTEM.md or another edit). Load the new text and save again.');
    }
    checkPlacement(ctx, patch);
    // Values are validated by the org service (names, avatars, policies, cycles).
    return ctx.services.org.update(agentId, patch as Partial<Agent>, PERSON);
  }, MANAGE);
  table.add('agents.archive', (params, ctx) => {
    const o = input(params);
    onlyKeys(o, ['id', 'successorId']);
    const successorId = optId(o, 'successorId');
    ctx.services.org.archive(id(o), { ...PERSON, ...(successorId ? { successorId } : {}) });
    return { ok: true };
  }, MANAGE);
  table.add('agents.restore', (params, ctx) => ctx.services.org.restore(id(input(params)), PERSON), MANAGE);
  table.add('agents.activity', (_params, ctx) => ctx.services.dispatcher.activity(), CHAT);

  // ---------------------------------------------------------------- runs
  table.add('agents.runs', (params, ctx) => {
    const o = input(params);
    const agentId = id(o);
    ctx.services.org.require(agentId);
    const limit = optNum(o, 'limit', { min: 1, max: 200 }) ?? 50;
    // B-057: the agent's own turns – its splits' runs are listed under their groups (splits.list).
    const runs = ctx.services.runs.listTopLevel?.(agentId, limit) ?? ctx.services.runs.list(agentId, limit);
    return runs.filter((run) => !run.splitId); // a journal without listTopLevel
  }, MANAGE);
  table.add('runs.items', (params, ctx) => {
    const runId = id(input(params), 'runId');
    checkRunAccess(ctx, ctx.services.runs.get(runId) ?? notFound('Run', { runId }));
    return ctx.services.runs.items(runId);
  }, CHAT);
  table.add('runs.cancel', async (params, ctx) => {
    const runId = id(input(params), 'runId');
    const run = ctx.services.runs.get(runId) ?? notFound('Run', { runId });
    // Finished runs have nothing to stop; the call stays idempotent. Stopping by run id never
    // hits another turn of the same agent (interrupt() without a chat stops whatever runs).
    if (run.status === 'running' || run.status === 'queued') {
      if (run.conversationId && !run.taskId && !run.splitId) clearChatRetry(ctx.services, run.agentId, run.conversationId);
      const { dispatcher } = ctx.services;
      if (dispatcher.cancelRun) await dispatcher.cancelRun(runId);
      else await dispatcher.interrupt(run.agentId, run.conversationId);
    }
    return { ok: true };
  }, MANAGE);
}

// ---------------------------------------------------------------- O6: avatar image and 'Works on'

const FILE_ID = /^[a-f0-9]{64}$/;

/**
 * An image avatar must be an uploaded image; `deviceId` must be this PC (stored as none – the
 * default) or a linked PC (not revoked, not still pairing) – the targets the agents.update tool
 * accepts (tools/registry.ts resolveDevice).
 */
function checkPlacement(ctx: HandlerContext, patch: Record<string, unknown>): void {
  const avatar = patch.avatar as { kind?: unknown; value?: unknown } | null | undefined;
  if (avatar && typeof avatar === 'object' && avatar.kind === 'image') {
    const file = typeof avatar.value === 'string' && FILE_ID.test(avatar.value) ? ctx.services.files.get(avatar.value) : undefined;
    if (!file || !file.mime.startsWith('image/')) throw new WorkforceError('bad_request', 'Choose an uploaded image for the avatar.', { details: { param: 'patch.avatar' } });
  }
  const deviceId = patch.deviceId;
  if (typeof deviceId !== 'string') return;
  if (deviceId === ctx.services.devices.self().id) { patch.deviceId = null; return; }
  const pc = ctx.services.devices.list().find((device) => device.id === deviceId);
  if (!pc || pc.kind !== 'pc' || pc.status === 'revoked' || pc.status === 'pairing') {
    throw new WorkforceError('bad_request', 'Choose this PC or a linked PC.', { details: { param: 'patch.deviceId' } });
  }
}

// ---------------------------------------------------------------- C5: run items in a chat

/**
 * A device without 'manage' reads only the items of a run that worked in a chat it can open
 * (every chat a 'chat' device may list, hidden team rooms and archived chats included), or – B-054
 * P10 – of a run without a chat whose task, if it has one, still exists. Never a run whose chat is
 * gone. The owner and 'manage' devices read every run.
 */
function checkRunAccess(ctx: HandlerContext, asked: Run): void {
  if (scopeHas(ctx.scope, 'manage')) return;
  const run = judgedRun(ctx, asked);
  if (run.conversationId && ctx.services.chats.get(run.conversationId)) return;
  if (!run.conversationId && (!run.taskId || ctx.services.tasks.get(run.taskId))) return;
  throw new WorkforceError('forbidden', 'Open this on your PC, or allow this phone in Settings › Devices.', { details: { runId: asked.id } });
}

/**
 * B-057: a split's run has no chat or task of its own – it is judged as its group's parent run (that turn's chat or
 * task), the rule splits.list/get apply (handlers/splits.ts); a split that cannot be found is not found.
 */
function judgedRun(ctx: HandlerContext, run: Run): Pick<Run, 'id' | 'conversationId' | 'taskId'> {
  if (!run.splitId) return run;
  const place = splitPlace(ctx.services, run.splitId) ?? notFound('Split', { id: run.splitId });
  return ctx.services.runs.get(place.parentRunId) ?? { id: place.parentRunId, conversationId: place.conversationId, taskId: place.taskId };
}
