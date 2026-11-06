// `confirm` ask widget: something the human does outside, then confirms. The link (if any)
// opens through the host. Answer: {done:true, note?}.
// Owns: instructions + Open + Done. Never: opens the link by itself.

import { Button } from '../../lib/ui.tsx';
import { Markdown } from '../markdown.tsx';
import { openLink } from '../host.ts';
import type { AskWidgetProps } from './ask-types.ts';
import { s } from './util.ts';

export function Confirm(props: AskWidgetProps) {
  const url = s(props.block.url);
  return (
    <div class="w-confirm">
      <Markdown text={s(props.block.instructions)} />
      <div class="w-actions">
        <Button variant="primary" busy={props.busy} onClick={() => void props.submit({ done: true })}>
          {s(props.block.confirmLabel) || 'Done'}
        </Button>
        {/^https?:|^mailto:/i.test(url) && <Button variant="secondary" onClick={() => openLink(url)} title={url}>Open</Button>}
      </div>
    </div>
  );
}
