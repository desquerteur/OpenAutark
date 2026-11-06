// `compare` block: options side by side (pros, cons, facts, the agent's pick). A swipe row
// with snap on phones instead of a squeezed grid.
// Owns: compare rendering. Never: more than one highlighted pick.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import { items, s, strings } from './util.ts';

export function Compare(props: { block: UiBlock }) {
  const options = items(props.block.options);
  const pickIndex = options.findIndex(option => option.pick === true);
  return (
    <div class="b-compare">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <div class="b-compare-row">
        {options.map((option, i) => (
          <div class={`b-compare-col${i === pickIndex ? ' is-pick' : ''}`} key={i}>
            <div class="b-compare-name">
              <Inline text={s(option.name)} />
              {i === pickIndex && <span class="b-pick"><Icon name="check" size={12} />Pick</span>}
            </div>
            {option.facts !== undefined && typeof option.facts === 'object' && (
              <dl class="b-facts">
                {Object.entries(option.facts as Record<string, unknown>).map(([key, value]) => (
                  <div key={key}><dt>{key}</dt><dd><Inline text={s(value)} /></dd></div>
                ))}
              </dl>
            )}
            {strings(option.pros).length > 0 && (
              <ul class="b-pros">{strings(option.pros).map((text, j) => <li key={j}><Icon name="plus" size={12} /><Inline text={text} /></li>)}</ul>
            )}
            {strings(option.cons).length > 0 && (
              <ul class="b-cons">{strings(option.cons).map((text, j) => <li key={j}><Icon name="x" size={12} /><Inline text={text} /></li>)}</ul>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
