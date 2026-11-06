// `timeline` block: chronology or schedule – date column, dot, title and optional text.
// Owns: timeline rendering. Never: parses or reformats the agent's dates.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Inline } from '../markdown.tsx';
import { items, s } from './util.ts';

export function Timeline(props: { block: UiBlock }) {
  return (
    <div class="b-timeline">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <ol>
        {items(props.block.items).map((item, i) => (
          <li key={i}>
            <span class="b-timeline-date tabular">{s(item.date)}</span>
            <span class="b-timeline-dot" aria-hidden="true" />
            <div class="b-step-text">
              <Inline text={s(item.title)} class="b-step-title" />
              {item.text !== undefined && <Inline text={s(item.text)} class="b-step-sub" />}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
