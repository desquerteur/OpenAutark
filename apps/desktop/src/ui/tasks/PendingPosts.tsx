// Rows under the task composer: quick posts on their way ("Sending…") or failed – with Retry (same clientId,
// never a second task), Edit (text and files back into the composer) and Dismiss.
// Owns: those rows. Never: keeps a task copy or retries by itself.

import { Icon, Spinner } from '../lib/ui.tsx';
import { draftFor, updateDraft } from '../chat/composer/draft.ts';
import { QUICK_DRAFT_KEY, dismissPost, pendingPosts, retryPost } from './quick-post.ts';
import type { PendingPost } from './quick-post.ts';

/** Edit: the post's text and files go back into the composer (after what it holds now). */
function editPost(post: PendingPost): void {
  const taken = dismissPost(post.clientId);
  if (!taken) return;
  const key = QUICK_DRAFT_KEY;
  const current = draftFor(key).peek();
  updateDraft(key, {
    text: current.text.trim() ? `${current.text}\n${taken.params.text}` : taken.params.text,
    attachments: [...current.attachments, ...taken.files.filter((file) => !current.attachments.some((entry) => entry.fileId === file.fileId))],
  });
}

function PendingRow(props: { post: PendingPost }) {
  const { post } = props;
  const failed = post.state === 'failed';
  return (
    <li class={`quick-post${failed ? ' failed' : ''}`}>
      <span class="quick-post-mark" aria-hidden="true">{failed ? <Icon name="warning-circle" size={18} /> : <Spinner size={16} />}</span>
      <span class="task-row-text">
        <span class="task-row-title">{post.title}</span>
        <span class="task-row-meta">{failed ? <span class="quick-post-error">Not sent · {post.error ?? 'Try again'}</span> : <span>Sending…</span>}</span>
      </span>
      {failed && (
        <span class="quick-post-actions">
          <button type="button" class="text-button" onClick={() => void retryPost(post.clientId)}>Retry</button>
          <button type="button" class="text-button" onClick={() => editPost(post)}>Edit</button>
          <button type="button" class="icon-button small" aria-label="Dismiss" title="Dismiss" onClick={() => dismissPost(post.clientId)}><Icon name="x" size={14} /></button>
        </span>
      )}
    </li>
  );
}

/** Posts not confirmed yet (usually gone within a moment) and failed ones. */
export function PendingPosts() {
  const list = pendingPosts.value;
  if (!list.length) return null;
  return <ul class="task-rows quick-posts" aria-label="Posting">{list.map((post) => <PendingRow key={post.clientId} post={post} />)}</ul>;
}
