// `choice` ask widget: options as calm buttons. Single choice answers on click; multi choice
// toggles and sends; "Other" adds one free-text field when the agent allowed it.
// Answer: {choice} or {choices} (+ other text as the value).
// Owns: choice interaction. Never: more than LIMITS.choiceOptions options (parse.ts caps it).

import { useState } from 'preact/hooks';
import { Button, Icon } from '../../lib/ui.tsx';
import { Inline } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { useDraft } from './use-draft.ts';
import { items, s } from './util.ts';

export function Choice(props: AskWidgetProps) {
  const { block } = props;
  const options = items(block.options);
  const multi = block.multi === true;
  const [picked, setPicked] = useDraft<string[]>(`${props.draftKey}.picked`, []);
  const [other, setOther] = useState('');

  const toggle = (value: string) => setPicked(picked.includes(value) ? picked.filter(v => v !== value) : [...picked, value]);
  const sendOther = () => {
    const text = other.trim();
    if (!text) return;
    void props.submit(multi ? { choices: [...picked, text] } : { choice: text });
  };

  return (
    <div class="w-choice">
      {block.question !== undefined && <div class="w-question"><Inline text={s(block.question)} /></div>}
      <div class="w-options" role={multi ? 'group' : 'radiogroup'}>
        {options.map((option, i) => {
          const value = s(option.value) || s(option.label);
          const selected = picked.includes(value);
          return (
            <button
              key={i}
              type="button"
              class={`w-option${selected ? ' is-selected' : ''}`}
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={selected}
              disabled={props.busy}
              title={s(option.hint) || undefined}
              onClick={() => (multi ? toggle(value) : void props.submit({ choice: value }))}
            >
              {multi && <span class="w-check" aria-hidden="true">{selected && <Icon name="check" size={12} />}</span>}
              <Inline text={s(option.label)} />
            </button>
          );
        })}
      </div>
      {block.allowOther === true && (
        <form class="w-other" onSubmit={(event) => { event.preventDefault(); sendOther(); }}>
          <input class="input" value={other} placeholder="Other" aria-label="Other" onInput={(event) => setOther((event.target as HTMLInputElement).value)} />
          {!multi && <Button type="submit" variant="secondary" disabled={!other.trim() || props.busy}>Send</Button>}
        </form>
      )}
      {multi && (
        <div class="w-actions">
          <Button variant="primary" busy={props.busy} disabled={picked.length === 0 && !other.trim()}
            onClick={() => void props.submit({ choices: other.trim() ? [...picked, other.trim()] : picked })}>
            Send
          </Button>
        </div>
      )}
    </div>
  );
}
