// My day's input row (B-041 §3, §4.1: "Das mache ich"): type or dictate – several things at once are fine – and
// everything stays the person's own (day.add; the runtime splits it, reads a time and a length – "morgen 9 Uhr eine
// halbe Stunde Steuern" becomes a block – and "timer 10 min" sets a timer). The AI always helps with wording and
// estimates; a to-do said to be private ("nur für mich") is one it leaves alone. Enter adds (Shift+Enter: a new
// line); while dictating, Enter first takes what was said. The Add arrow is always at the row's end (disabled
// while empty), so typing moves nothing.
// Owns: the row's text. Never: decides who does what (the runtime) or keeps a draft.

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { isMobile } from '../lib/store.ts';
import { Icon, IconButton, Spinner } from '../lib/ui.tsx';
import { addToDay } from './day-actions.ts';
import { revealTodo, shownDate, today } from './day-state.ts';
import { dayTitle, joinSaid } from './day-format.ts';
import { useFieldDictation } from './use-dictation.ts';

const KEY = 'day:input';

export function DayInput(props: { compact?: boolean }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const mic = useFieldDictation(KEY, (said) => setText((current) => joinSaid(current, said)));
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    const edge = el.offsetHeight - el.clientHeight; // the bottom border: the box height counts it, scrollHeight does not (else a scrollbar shows)
    el.style.height = `${Math.min(el.scrollHeight + edge, 180)}px`;
  }, [text]);
  const current = today.value;
  const day = shownDate.value > current ? shownDate.value : undefined; // the list shows a later day: what is typed is for it
  const dayName = day ? dayTitle(day, current) : '';

  const submit = async () => {
    if (busy) return;
    const value = (mic.active ? joinSaid(text, await mic.stop()) : text).trim();
    if (!value) return;
    setBusy(true);
    const added = await addToDay(value, day); // another day shown: the items are for that day
    setBusy(false);
    if (!added) { setText(value); return; } // the toast said why; the text stays
    setText('');
    if (added.length === 1) revealTodo(added[0].id);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (mic.active) mic.cancel(); else setText('');
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !isMobile.value) { event.preventDefault(); void submit(); }
  };
  const has = text.trim().length > 0;
  return (
    <form class={`todo-add day-input${props.compact ? ' compact' : ''}`} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <span class="todo-add-icon" aria-hidden="true">{busy ? <Spinner size={14} /> : <Icon name="plus" size={16} />}</span>
      <textarea ref={field} class="todo-add-input day-input-field" rows={1} value={text} maxLength={4000} disabled={busy}
        placeholder={mic.active ? 'Listening…' : day ? `Add a to-do for ${dayName === 'Tomorrow' ? 'tomorrow' : dayName}` : 'Add a to-do'} aria-label="Add a to-do"
        onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)} onKeyDown={onKeyDown} />
      <span class="day-input-actions">
        {mic.transcribing
          ? <span class="icon-button small" aria-label="Transcribing dictation"><Spinner size={14} label="Transcribing dictation" /></span>
          : mic.available && (
            <IconButton icon={mic.active ? 'stop' : 'microphone'} size="small" label={mic.active ? 'Stop dictation' : 'Dictate'} pressed={mic.active}
              disabled={busy} onClick={() => void mic.toggle()} />
          )}
        {/* always there (disabled while empty), on every width: typing never inserts a button into the row */}
        <IconButton icon="arrow-up" size="small" label="Add" type="submit" disabled={busy || (!has && !mic.active)} />
      </span>
    </form>
  );
}
