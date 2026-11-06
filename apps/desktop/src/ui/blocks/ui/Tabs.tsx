// `tabs` block: groups display blocks to save space; a segmented control on top.
// Owns: the selected tab (local). Never: nests tabs or hosts ask blocks (parse.ts refuses both).

import { useState } from 'preact/hooks';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { DisplayBlock } from '../registry.tsx';
import { items, s } from './util.ts';

export function Tabs(props: { block: UiBlock }) {
  const tabs = items(props.block.tabs);
  const [active, setActive] = useState(0);
  const current = tabs[Math.min(active, tabs.length - 1)];
  const blocks = current && Array.isArray(current.blocks) ? (current.blocks as UiBlock[]) : [];
  return (
    <div class="b-tabs">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <div class="b-segmented" role="tablist">
        {tabs.map((tab, i) => (
          <button key={i} type="button" role="tab" aria-selected={i === active} class={i === active ? 'is-active' : undefined} onClick={() => setActive(i)}>
            {s(tab.label)}
          </button>
        ))}
      </div>
      <div role="tabpanel" class="b-tab-panel">
        {blocks.filter(block => block.type !== 'tabs').map((block, i) => <DisplayBlock key={`${active}-${i}`} block={block} />)}
      </div>
    </div>
  );
}
