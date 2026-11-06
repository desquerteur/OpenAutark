// Picking a time in My day's calendar (B-041 §4.1 – "auf einen bestimmten Zeitraum klicken und dort direkt
// reindiktieren"): click a free time or drag over it (a pointer), or with the keyboard step through the hours
// (one tab stop; ↑ ↓ Home End move, Enter picks the hour) – then type or dictate into the inline field, which
// adds exactly that range (calendar.add 'auto'). The day grid and every column of the week use it.
// Owns: the selection, the hour stops and the slot field. Never: loads the calendar window or polls.

import { useEffect, useRef, useState } from 'preact/hooks';
import { IconButton, Spinner } from '../lib/ui.tsx';
import { addToSlot } from './day-actions.ts';
import { DAY_MINUTES, HOUR_PX, atMinute, clickSpan, selection } from './day-grid.ts';
import type { Span } from './day-grid.ts';
import { joinSaid } from './day-format.ts';
import { useFieldDictation } from './use-dictation.ts';

const pad = (n: number) => String(n).padStart(2, '0');
export const minuteText = (minute: number) => `${pad(Math.floor(minute / 60) % 24)}:${pad(minute % 60)}`;

/** The typed or dictated text for a selected range. */
export function SlotField(props: { date: string; tz: string; span: Span; onClose: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const mic = useFieldDictation('day:slot', (said) => setText((current) => joinSaid(current, said)));
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { field.current?.focus(); }, []); // the autofocus attribute does nothing on an element added later
  const { span } = props;
  const save = async () => {
    const value = (mic.active ? joinSaid(text, await mic.stop()) : text).trim();
    if (!value || busy) { if (!value) props.onClose(); return; }
    setBusy(true);
    const ok = await addToSlot(value, atMinute(props.date, span.start, props.tz), atMinute(props.date, span.end, props.tz));
    setBusy(false);
    if (ok) props.onClose(); else setText(value);
  };
  const top = (span.start / 60) * HOUR_PX;
  const height = Math.max(((span.end - span.start) / 60) * HOUR_PX, 40);
  return (
    <form class="day-slot" style={{ top: `${top}px`, minHeight: `${height}px` }} onSubmit={(e) => { e.preventDefault(); void save(); }}
      onPointerDown={(e) => e.stopPropagation()}>
      <span class="day-slot-time tabular">{minuteText(span.start)}–{minuteText(span.end)}</span>
      <span class="day-slot-row">
        <input ref={field} class="day-slot-input" type="text" value={text} maxLength={500} autoFocus disabled={busy}
          placeholder={mic.active ? 'Listening…' : 'What happens then?'} aria-label={`Add at ${minuteText(span.start)}`}
          onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (mic.active) mic.cancel(); props.onClose(); } }} />
        {busy ? <Spinner size={14} />
          : mic.available && <IconButton icon={mic.active ? 'stop' : 'microphone'} size="small" label={mic.active ? 'Stop dictation' : 'Dictate'} pressed={mic.active} onClick={() => void mic.toggle()} />}
      </span>
    </form>
  );
}

/** The selection of one day's column: pointer handlers for its element (`target`), the picked range, pick and close. */
export function useSlotPicker() {
  const target = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Span | null>(null);
  const press = useRef<{ minute: number; y: number; moved: boolean; id: number; touch: boolean } | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const minuteAt = (clientY: number) => {
    const rect = target.current?.getBoundingClientRect();
    return rect ? Math.min(DAY_MINUTES, Math.max(0, ((clientY - rect.top) / HOUR_PX) * 60)) : 0;
  };
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as Element).closest('.day-block, .day-slot')) return;
      press.current = { minute: minuteAt(e.clientY), y: e.clientY, moved: false, id: e.pointerId, touch: e.pointerType === 'touch' };
      if (!press.current.touch) target.current?.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: PointerEvent) => {
      const state = press.current;
      if (!state || state.id !== e.pointerId || state.touch) return;
      if (!state.moved && Math.abs(e.clientY - state.y) < 4) return;
      state.moved = true;
      setDraft(selection(state.minute, minuteAt(e.clientY)));
    },
    onPointerUp: (e: PointerEvent) => {
      const state = press.current;
      press.current = null;
      if (!state || state.id !== e.pointerId) return;
      returnTo.current = null;
      setDraft(state.moved ? selection(state.minute, minuteAt(e.clientY)) : clickSpan(state.minute));
    },
    onPointerCancel: () => { press.current = null; },
  };
  /** The keyboard's pick: the hour's range; closing the field goes back to that hour. */
  const pick = (minute: number, from: HTMLElement) => { returnTo.current = from; setDraft(clickSpan(minute)); };
  const close = () => { setDraft(null); returnTo.current?.focus(); returnTo.current = null; };
  return { target, draft, setDraft, handlers, pick, close };
}

/**
 * One stop per hour for the keyboard, as a single tab stop (roving): ↑ ↓ Home End move, Enter (or Space)
 * picks the hour. Pointers pass through them to the column (its click and drag).
 */
export function HourStops(props: { start: number; onPick: (minute: number, from: HTMLElement) => void }) {
  const [hour, setHour] = useState(Math.min(23, Math.max(0, Math.floor(props.start / 60))));
  const root = useRef<HTMLDivElement>(null);
  const go = (next: number) => {
    const target = Math.min(23, Math.max(0, next));
    setHour(target);
    root.current?.querySelector<HTMLButtonElement>(`[data-hour="${target}"]`)?.focus();
  };
  const keys: Record<string, (h: number) => number> = { ArrowDown: (h) => h + 1, ArrowUp: (h) => h - 1, Home: () => 0, End: () => 23, PageDown: (h) => h + 4, PageUp: (h) => h - 4 };
  return (
    <div class="day-cal-stops" ref={root}>
      {Array.from({ length: 24 }, (_, h) => (
        <button key={h} type="button" class="day-cal-stop" data-hour={h} tabIndex={h === hour ? 0 : -1} aria-label={`Add at ${minuteText(h * 60)}`}
          style={{ top: `${h * HOUR_PX}px`, height: `${HOUR_PX}px` }}
          onFocus={() => setHour(h)}
          onClick={(e) => { if (e.detail === 0) props.onPick(h * 60, e.currentTarget); }}
          onKeyDown={(e) => { const move = keys[e.key]; if (move) { e.preventDefault(); go(move(h)); } }} />
      ))}
    </div>
  );
}
