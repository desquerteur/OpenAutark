// What a person's device may call, part 4: their files and taking work –
//  * files: upload into one of their chats (files.uploadChunk with `conversationId`, people/uploads.ts) and
//    read the files they may read (files.get / files.read: people/access.ts mayReadFile – attachments of their
//    chats from their visible time on, avatars, their own uploads); a short recorded utterance goes through
//    files.upload (people/rpc-voice.ts);
//  * work: take unassigned team work of a chat they are in (tasks.makeMine – "Make it mine").
// Every call first checks that the person's token and access still hold (rpc-base.ts caller).
// Owns: these person variants. Never: the owner's handlers or another person's files.

import { WorkforceError } from '../../shared/errors.ts';
import type { Person } from '../../shared/model/people.ts';
import type { FileRef } from '../../shared/model/system.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { bad, fileId, id, input, num, onlyKeys, optBool, optNum, text } from '../rpc/params.ts';
import type { HandlerContext, HandlerTable } from '../rpc/table.ts';
import { base64Length } from '../rpc/uploads.ts';
import { mayReadFile, mayReadTask, membership, personFileView } from './access.ts';
import { viewTaskFor } from './perspective.ts';
import { caller } from './rpc-base.ts';
import { personUpload } from './uploads.ts';

const READ_DEFAULT_BYTES = 5 * 1024 * 1024;
const READ_MAX_BYTES = 25 * 1024 * 1024;

function deviceOf(ctx: HandlerContext): string {
  if (ctx.scope.kind !== 'person') throw new WorkforceError('forbidden', 'Only people of the organisation use this.');
  return ctx.scope.deviceId;
}

/** A file the person may read (else 'not found' – no hint that it exists), under the name they know it by. */
function readableFile(ctx: HandlerContext, person: Person, params: unknown): FileRef {
  const fileIdOf = fileId(input(params), 'id');
  const ref = ctx.services.files.get(fileIdOf);
  if (!ref || !mayReadFile(ctx.services.db, person.id, fileIdOf)) throw new WorkforceError('not_found', 'File not found.', { details: { id: fileIdOf } });
  return personFileView(ctx.services.db, person.id, ref);
}

/** Unassigned team work of a chat the person is in, not finished, not a step: theirs to take. */
export function claimable(ctx: HandlerContext, person: Person, task: TaskView): boolean {
  return !task.parentId && task.assigneeKind === 'team' && task.status !== 'done' && task.status !== 'cancelled'
    && !!task.conversationId && membership(ctx.services.db, person.id, task.conversationId) !== undefined && mayReadTask(ctx.services.db, person.id, task);
}

/** "Make it mine": the person takes unassigned team work of their chat. */
export function claimFor(ctx: HandlerContext, person: Person, task: TaskView): TaskView {
  if (!claimable(ctx, person, task)) throw new WorkforceError('forbidden', 'Only unassigned work of a chat you are in can be taken.', { details: { taskId: task.id } });
  return ctx.services.tasks.assign(task.id, { kind: 'human', id: person.id }, person.id);
}

export function registerPersonWork(table: HandlerTable): void {
  table.addPerson('files.uploadChunk', async (params, ctx) => {
    const person = caller(ctx);
    const o = input(params);
    onlyKeys(o, ['uploadId', 'index', 'dataBase64', 'final', 'name', 'mime', 'conversationId']);
    if (o.conversationId === undefined) bad('conversationId', 'the chat this file is for');
    return personUpload(ctx.services, person, deviceOf(ctx), {
      uploadId: text(o, 'uploadId', { max: 64 }), index: num(o, 'index', { min: 0, max: 100_000 }),
      dataBase64: text(o, 'dataBase64', { max: base64Length(4 * 1024 * 1024) + 4, allowEmpty: true }),
      final: optBool(o, 'final') ?? false, name: text(o, 'name', { max: 200 }), conversationId: id(o, 'conversationId'),
    });
  });
  table.addPerson('files.get', (params, ctx) => readableFile(ctx, caller(ctx), params));
  table.addPerson('files.read', async (params, ctx) => {
    const person = caller(ctx);
    const file = readableFile(ctx, person, params);
    const maxBytes = optNum(input(params), 'maxBytes', { min: 1, max: READ_MAX_BYTES }) ?? READ_DEFAULT_BYTES;
    if (file.size > maxBytes) throw new WorkforceError('bad_request', 'This file is too large to send here.', { details: { size: file.size, maxBytes } });
    const bytes = await ctx.services.files.read(file.id);
    return { dataBase64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'), mime: file.mime };
  });

  table.addPerson('tasks.makeMine', (params, ctx) => {
    const person = caller(ctx);
    const task = ctx.services.tasks.get(id(input(params)));
    if (!task || !mayReadTask(ctx.services.db, person.id, task)) throw new WorkforceError('not_found', 'Task not found.');
    return viewTaskFor(ctx.services, person.id, claimFor(ctx, person, task));
  });
}
