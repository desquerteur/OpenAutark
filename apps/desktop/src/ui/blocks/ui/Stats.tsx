// `stats` block: KPI tiles (value, label, delta with trend). Wraps 2 per row on phones.
// Owns: tile rendering. Never: colours a delta without a trend (no guessing good/bad).

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import { items, s } from './util.ts';

export function Stats(props: { block: UiBlock }) {
  return (
    <div class="b-stats">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <div class="b-stats-grid">
        {items(props.block.items).map((item, i) => (
          <div class="b-stat" key={i}>
            <div class="b-stat-value tabular">{s(item.value)}</div>
            <div class="b-stat-label">{s(item.label)}</div>
            {item.delta !== undefined && (
              <div class={`b-stat-delta trend-${s(item.trend) || 'flat'}`}>
                {item.trend === 'up' && <Icon name="arrow-up" size={12} />}
                {item.trend === 'down' && <Icon name="arrow-down" size={12} />}
                <span class="tabular">{s(item.delta)}</span>
              </div>
            )}
            {item.hint !== undefined && <div class="b-stat-hint">{s(item.hint)}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
