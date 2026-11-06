// The task center's quick posts in the UI (src/ui/tasks/quick-post.ts): a post shows as "Sending…" at
// once and many can be on their way together; the answer lands in the open-task store, but never over
// a newer task event that came first; a failed post stays with its error, Retry sends the same
// clientId (one task, not two) and Dismiss hands back text and files for Edit; the composer's input
// becomes the quickCreate params with empty fields left out; B-054: the draft lives under a fixed local key (no Inbox chat).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { QuickTaskParams, QuickTaskResult } from '../../../src/shared/model/task-center.ts';
import type { TaskView } from '../../../src/shared/model/tasks.ts';
import type { Attachment } from '../../../src/shared/model/chat.ts';
import { tasks } from '../../../src/ui/lib/store.ts';
import {
  QUICK_DRAFT_KEY, acceptIntoStore, dismissPost, pendingPosts, postQuickTask, quickParams, resetQuickPosts, retryPost,
} from '../../../src/ui/tasks/quick-post.ts';
import type { PostDeps } from '../../../src/ui/tasks/quick-post.ts';

const view = (id: string, patch: Partial<TaskView> = {}): TaskView => ({
  id, title: id, notes: '', status: 'open', assigneeKind: 'team', createdBy: 'human',
  priority: 0, ledger: {}, attempts: 0, sort: 0, rev: 1, createdAt: 1, updatedAt: 1, steps: [], progress: { done: 0, total: 0 },
  conversationTitle: '', running: false, ...patch,
});

/** A runtime fake: answers each call when told; the same clientId gives the same task. */
function runtime() {
  const calls: QuickTaskParams[] = [];
  const waiting: Array<{ params: QuickTaskParams; resolve: (result: QuickTaskResult) => void; reject: (error: Error) => void }> = [];
  const byClient = new Map<string, TaskView>();
  const deps: PostDeps = {
    create: (params) => new Promise((resolve, reject) => { calls.push(params); waiting.push({ params, resolve, reject }); }),
    accept: acceptIntoStore, // the real store rule
  };
  const answer = (index: number) => {
    const call = waiting[index];
    const task = byClient.get(call.params.clientId!) ?? view(`task_${byClient.size + 1}`, { title: call.params.text });
    byClient.set(call.params.clientId!, task);
    call.resolve({ task });
  };
  const fail = (index: number, message: string) => waiting[index].reject(new Error(message));
  return { calls, deps, answer, fail };
}

test('posts show at once, several can be on their way, the answers land in the store', async () => {
  resetQuickPosts();
  tasks.value = [];
  const rt = runtime();
  const first = postQuickTask({ text: 'Cut the intro' }, { deps: rt.deps });
  const second = postQuickTask({ text: 'Write the outro' }, { deps: rt.deps });
  assert.deepEqual(pendingPosts.value.map((post) => [post.title, post.state]), [['Write the outro', 'sending'], ['Cut the intro', 'sending']], 'newest first, before any answer');
  assert.notEqual(rt.calls[0].clientId, rt.calls[1].clientId, 'one clientId per post');
  rt.answer(1);
  rt.answer(0);
  await Promise.all([first, second]);
  assert.deepEqual(pendingPosts.value, [], 'confirmed posts leave the pending list');
  assert.deepEqual(tasks.value.map((task) => task.title).sort(), ['Cut the intro', 'Write the outro']);
});

test('the answer never overwrites a newer task event that arrived first', async () => {
  resetQuickPosts();
  const routed = view('task_1', { assigneeKind: 'agent', assigneeId: 'ag_vic' });
  tasks.value = [routed];
  const rt = runtime();
  const done = postQuickTask({ text: 'task_1' }, { deps: rt.deps });
  rt.answer(0); // answers with the older 'pending' view of task_1
  await done;
  assert.equal(tasks.value.length, 1);
  assert.equal(tasks.value[0].assigneeId, 'ag_vic', 'the routed view stays');
});

test('a failed post stays with its error; Retry reuses the clientId; Dismiss hands text and files back', async () => {
  resetQuickPosts();
  tasks.value = [];
  const rt = runtime();
  const files: Attachment[] = [{ fileId: 'f'.repeat(64), name: 'brief.pdf', mime: 'application/pdf', size: 10 }];
  const post = postQuickTask(quickParams({ text: ' Review the brief ', attachments: files }), { files, deps: rt.deps });
  rt.fail(0, 'Offline');
  assert.equal(await post, null);
  const [failed] = pendingPosts.value;
  assert.deepEqual([failed.state, failed.error, failed.title], ['failed', 'Offline', 'Review the brief']);
  const retried = retryPost(failed.clientId, rt.deps);
  assert.equal(pendingPosts.value[0].state, 'sending');
  rt.fail(1, 'Still offline');
  await retried;
  assert.equal(rt.calls[1].clientId, rt.calls[0].clientId, 'the same clientId: the runtime returns the first task, never a second one');
  const taken = dismissPost(failed.clientId);
  assert.equal(taken?.params.text, 'Review the brief');
  assert.deepEqual(taken?.files, files, 'Edit gets the files with their names and types');
  assert.deepEqual(pendingPosts.value, []);
  assert.equal(dismissPost(failed.clientId), undefined);
});

test('the composer input becomes quickCreate params, empty fields left out', () => {
  assert.deepEqual(quickParams({ text: '  Fix it  ', attachments: [] }), { text: 'Fix it' });
  assert.deepEqual(quickParams({
    text: 'Edit', attachments: [{ fileId: 'a', name: 'take.webm', durationMs: 4000 }], target: { kind: 'team', id: 'Video' },
  }), { text: 'Edit', attachments: [{ fileId: 'a', name: 'take.webm', durationMs: 4000 }], target: { kind: 'team', id: 'Video' } });
  assert.deepEqual(quickParams({ text: 'Pick the colours', attachments: [], target: { kind: 'person', id: 'per_zoe' } }),
    { text: 'Pick the colours', target: { kind: 'person', id: 'per_zoe' } });
});

test('B-054: the draft key is a fixed local key, no chat', () => {
  resetQuickPosts();
  assert.equal(QUICK_DRAFT_KEY, 'local:quick-task');
  assert.ok(!QUICK_DRAFT_KEY.startsWith('ch_') && !QUICK_DRAFT_KEY.startsWith('conv_'), 'never a chat id');
});
