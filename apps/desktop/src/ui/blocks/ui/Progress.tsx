// `progress` block: status of long work (agents reuse the block id to tick it forward).
// Owns: label, thin bar (indeterminate without a value), status and detail line.
// Never: animates beyond the CSS indeterminate hint (reduced motion turns it static).

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Inline } from '../markdown.tsx';
import { s } from './util.ts';

export function Progress(props: { block: UiBlock }) {
  const value = typeof props.block.value === 'number' ? props.block.value : undefined;
  const status = s(props.block.status) || 'running';
  const filled = value ?? (status === 'done' ? 1 : 0);
  return (
    <div class={`b-progress is-${status}`}>
      <div class="b-progress-head">
        <Inline text={s(props.block.label)} class="b-step-title" />
        <span class="b-progress-meta tabular">
          {value !== undefined ? `${Math.round(value * 100)} %` : status !== 'running' ? status : ''}
        </span>
      </div>
      <div class={`b-bar${value === undefined && status === 'running' ? ' indeterminate' : ''}`}
        role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value !== undefined ? Math.round(value * 100) : undefined}
        aria-label={s(props.block.label)}>
        <span style={{ width: `${Math.round(filled * 100)}%` }} />
      </div>
      {props.block.detail !== undefined && <Inline text={s(props.block.detail)} class="b-step-sub" />}
    </div>
  );
}
