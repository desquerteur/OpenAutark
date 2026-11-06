// `cards` block: links, results or a small gallery. Links open through the host; remote
// images are click-to-load (no beacons from agent output).
// Owns: card rendering. Never: more than 3 meta lines or nested actions per card.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Icon } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import { openLink } from '../host.ts';
import { MediaImage } from './Media.tsx';
import { items, s } from './util.ts';

export function Cards(props: { block: UiBlock }) {
  return (
    <div class="b-cards">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <div class="b-cards-grid">
        {items(props.block.items).map((item, i) => {
          const url = s(item.url);
          const body = (
            <>
              {item.image !== undefined && <MediaImage src={s(item.image)} alt={s(item.title)} />}
              <div class="b-card-title"><Inline text={s(item.title)} />{url && <Icon name="caret-right" size={12} />}</div>
              {item.text !== undefined && <Inline text={s(item.text)} class="b-card-text" />}
              {item.meta !== undefined && <div class="b-card-meta">{s(item.meta)}</div>}
            </>
          );
          return url
            ? <button type="button" class="b-card is-link" key={i} title={url} onClick={() => openLink(url)}>{body}</button>
            : <div class="b-card" key={i}>{body}</div>;
        })}
      </div>
    </div>
  );
}
