// Quick posts of the task center (Work, 17:37): one line of work → tasks.quickCreate. The composer empties at
// once and the post shows as "Sending…" until the runtime answers (a second, third … post can follow right
// away); the answer goes into the store's open tasks – unless the task event got there first, which is never
// overwritten by the older answer – and routing results arrive as task events. A failed post stays as a row
// with Retry (same clientId: the runtime returns the task the first attempt made, never a second one), Edit
// (back into an empty field) and Dismiss – for this window session only: posts on their way or failed live in
// memory, so a reload or restart drops them (the runtime made no task of a failed post; nothing is half-sent).
// The recipient (Auto, "Me" – every part to My day –, an agent, a branch, a team or a person) stays chosen for the
// next posts until changed.
// Also the fixed local key the composer's draft is kept under (a quick task is chat-free; the draft lives in
// this window's memory, chat/composer/draft.ts).
// Owns: these signals and the post/retry/dismiss flow. Never: decides routing (the runtime does) or keeps a
// copy of a task (only ids and the person's own input).

import { signal } from '@preact/signals';
import type { QuickTaskParams, QuickTaskResult, QuickTaskTarget } from '../../shared/model/task-center.ts';
import type { Attachment } from '../../shared/model/chat.ts';
import type { TaskView } from '../../shared/model/tasks.ts';
import { newId } from '../../shared/ids.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { tasks, upsertById } from '../lib/store.ts';
import { postTitle } from './center-model.ts';

export interface PendingPost {
  clientId: string;
  title: string;
  state: 'sending' | 'failed';
  error?: string;
  params: QuickTaskParams & { clientId: string };
  /** The files as the composer held them (Edit puts them back). */
  files: Attachment[];
}

/** Posts on their way or failed, newest first. */
export const pendingPosts = signal<PendingPost[]>([]);
/** The key the quick composer's draft is kept under (no chat: a fixed local key). */
export const QUICK_DRAFT_KEY = 'local:quick-task';
/** The recipient of the next posts (undefined = Auto). */
export const composerTarget = signal<QuickTaskTarget | undefined>(undefined);

export interface PostDeps {
  create(params: QuickTaskParams): Promise<QuickTaskResult>;
  /** Files the created task into the open-task store (only when no newer event did). */
  accept(view: TaskView): void;
}

/** The default accept: into the open-task store, unless task.upserted already put a (newer) view there. */
export function acceptIntoStore(view: TaskView): void {
  if (view.status === 'done' || view.status === 'cancelled') return;
  if (tasks.peek().some((task) => task.id === view.id)) return; // task.upserted came first and is newer
  upsertById(tasks, view);
}

const defaultDeps: PostDeps = { create: (params) => rpc.call('tasks.quickCreate', params), accept: acceptIntoStore };

function patch(clientId: string, change: Partial<PendingPost> | null): void {
  pendingPosts.value = change === null
    ? pendingPosts.value.filter((post) => post.clientId !== clientId)
    : pendingPosts.value.map((post) => (post.clientId === clientId ? { ...post, ...change } : post));
}

async function send(post: PendingPost, deps: PostDeps): Promise<TaskView | null> {
  try {
    const { task } = await deps.create(post.params);
    deps.accept(task);
    patch(post.clientId, null);
    return task;
  } catch (error) {
    patch(post.clientId, { state: 'failed', error: errorText(error) });
    return null;
  }
}

/** What the composer holds, as the quick post's params (empty fields left out). */
export function quickParams(input: { text: string; attachments: Array<{ fileId: string; name?: string; durationMs?: number }>; target?: QuickTaskTarget }): QuickTaskParams {
  return {
    text: input.text.trim(),
    ...(input.attachments.length ? { attachments: input.attachments.map((file) => ({ fileId: file.fileId, ...(file.name ? { name: file.name } : {}), ...(file.durationMs !== undefined ? { durationMs: file.durationMs } : {}) })) } : {}),
    ...(input.target ? { target: input.target } : {}),
  };
}

/** Posts one quick task: shown as "Sending…" at once; resolves with the task, or null when it failed (the row stays). */
export function postQuickTask(params: QuickTaskParams, options: { files?: Attachment[]; deps?: PostDeps } = {}): Promise<TaskView | null> {
  const clientId = newId('up');
  const files = options.files ?? [];
  const post: PendingPost = {
    clientId, state: 'sending', files, params: { ...params, clientId },
    title: postTitle(params.text, files.length ? files.map((file) => file.name) : (params.attachments ?? []).map((file) => file.name ?? '')),
  };
  pendingPosts.value = [post, ...pendingPosts.value];
  return send(post, options.deps ?? defaultDeps);
}

/** Retry a failed post with its own clientId (never a second task). */
export function retryPost(clientId: string, deps: PostDeps = defaultDeps): Promise<TaskView | null> {
  const post = pendingPosts.peek().find((entry) => entry.clientId === clientId);
  if (!post || post.state !== 'failed') return Promise.resolve(null);
  patch(clientId, { state: 'sending', error: undefined });
  return send({ ...post, state: 'sending' }, deps);
}

/** Drops a failed post; returns its input (Edit puts the text back into the composer). */
export function dismissPost(clientId: string): PendingPost | undefined {
  const post = pendingPosts.peek().find((entry) => entry.clientId === clientId);
  if (!post || post.state !== 'failed') return undefined;
  patch(clientId, null);
  return post;
}

/** Tests: forget every post. */
export function resetQuickPosts(): void {
  pendingPosts.value = [];
  composerTarget.value = undefined;
}
