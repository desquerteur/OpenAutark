// `checklist` ask widget: things the human ticks off (airy rows, round circles, check icon +
// strike-through). Sends automatically when everything is ticked, or on "Done".
// Answer: {checked:[texts], open:[texts]}. Owns: tick state (kept as a local draft).

import { Button } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import { StatusCircle } from './Steps.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { useDraft } from './use-draft.ts';
import { items, s } from './util.ts';

export function Checklist(props: AskWidgetProps) {
  const list = items(props.block.items).map(item => ({ text: s(item.text), done: item.done === true }));
  const [checked, setChecked] = useDraft<number[]>(`${props.draftKey}.checked`, list.flatMap((item, i) => (item.done ? [i] : [])));
  const done = (i: number) => checked.includes(i);

  const send = (indexes: number[]) => void props.submit({
    checked: list.filter((_, i) => indexes.includes(i)).map(item => item.text),
    open: list.filter((_, i) => !indexes.includes(i)).map(item => item.text),
  });

  const toggle = (i: number) => {
    const next = done(i) ? checked.filter(n => n !== i) : [...checked, i];
    setChecked(next);
    if (next.length === list.length && list.length > 0) send(next);
  };

  return (
    <div class="w-checklist">
      <div class="w-progress-head">
        <span class="tabular">{checked.length} of {list.length} completed</span>
      </div>
      <div class="w-thin-bar"><span style={{ width: `${list.length ? (checked.length / list.length) * 100 : 0}%` }} /></div>
      <ul>
        {list.map((item, i) => (
          <li key={i} class={done(i) ? 'is-done' : undefined}>
            <button type="button" role="checkbox" aria-checked={done(i)} disabled={props.busy} onClick={() => toggle(i)}>
              <StatusCircle status={done(i) ? 'done' : 'todo'} />
              <Inline text={item.text} class="w-check-text" />
            </button>
          </li>
        ))}
      </ul>
      {checked.length > 0 && checked.length < list.length && (
        <div class="w-actions">
          <Button variant="secondary" busy={props.busy} onClick={() => send(checked)}>Done</Button>
        </div>
      )}
    </div>
  );
}
