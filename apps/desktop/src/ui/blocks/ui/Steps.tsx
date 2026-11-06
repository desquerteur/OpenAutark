// `steps` block: plan / process / "what I did" in the airy checklist look (round circles,
// check icon plus strike-through for done – never strike-through alone).
// Owns: steps rendering and the shared StatusCircle. Never: per-item cards.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import { items, s } from './util.ts';

/** Round status circle: empty (todo), ring (active), filled check (done), x (failed). */
export function StatusCircle(props: { status?: string; size?: number }) {
  const status = props.status ?? 'todo';
  return (
    <span class={`b-circle is-${status}`} aria-hidden="true" style={props.size ? { width: `${props.size}px`, height: `${props.size}px` } : undefined}>
      {status === 'done' && <Icon name="check" size={12} />}
      {status === 'failed' && <Icon name="x" size={12} />}
    </span>
  );
}

const STATUS_LABEL: Record<string, string> = { done: 'done', active: 'in progress', todo: 'to do', failed: 'failed' };

export function Steps(props: { block: UiBlock }) {
  const list = items(props.block.items);
  return (
    <div class="b-steps">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <ol>
        {list.map((item, i) => {
          const status = s(item.status) || 'todo';
          return (
            <li key={i} class={`is-${status}`}>
              <StatusCircle status={status} />
              <div class="b-step-text">
                <Inline text={s(item.title)} class="b-step-title" />
                <span class="sr-only"> ({STATUS_LABEL[status] ?? status})</span>
                {item.text !== undefined && <Inline text={s(item.text)} class="b-step-sub" />}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
