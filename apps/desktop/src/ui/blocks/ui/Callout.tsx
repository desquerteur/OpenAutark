// `callout` block: key point, result or warning – an icon and inline-rendered Markdown.
// Owns: callout look per tone. Never: card chrome beyond a subtle tone accent.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import type { IconName } from '../../lib/ui.tsx';
import { Markdown } from '../markdown.tsx';
import { s } from './util.ts';

const TONE_ICON: Record<string, IconName> = { info: 'info', success: 'check-circle', warning: 'warning-circle', danger: 'warning-circle' };

export function Callout(props: { block: UiBlock }) {
  const tone = s(props.block.tone) || 'info';
  return (
    <div class={`b-callout tone-${tone}`} role={tone === 'danger' || tone === 'warning' ? 'note' : undefined}>
      <Icon name={TONE_ICON[tone] ?? 'info'} size={18} />
      <div class="b-callout-body">
        {props.block.title && <div class="b-title">{props.block.title}</div>}
        <Markdown text={s(props.block.text)} />
      </div>
    </div>
  );
}
