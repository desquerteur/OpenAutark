// The model tag's markup (B-050 K6; model-tag-view.ts decides which messages and tasks carry one and its words): a
// pin when pinned, the short name, the tooltip. Small and muted in the row it sits in – a message's meta row, a task
// bubble's head – so nothing moves around it.
// Owns: that markup. Never: decides whether a tag is shown.

import { Icon } from '../lib/ui.tsx';
import type { ModelTagView } from './model-tag-view.ts';

export function ModelTagMark(props: { tag: ModelTagView | undefined; class?: string }) {
  const { tag } = props;
  if (!tag) return null;
  return (
    <span class={`message-model${props.class ? ` ${props.class}` : ''}`} title={tag.title}>
      {tag.pinned && <Icon name="push-pin" size={11} />}<span class="message-model-name">{tag.name}</span>
    </span>
  );
}
