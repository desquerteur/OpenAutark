// The settings block of the composer's schedule mode: it sits ABOVE the text inside the composer frame (the text
// area below grows, the composer grows from the bottom up). Four fixed rows, the same in every choice, so a click
// moves nothing: [Once | Repeat] (+ [Days | Interval | Advanced]) and ×; the fields (Once: date and time; Days: weekday
// buttons at a time; Interval: every N minutes/hours/days/weeks; Advanced: a cron rule); one-tap times (Once) or the
// optional start and end (Repeat); and one line that says what happens – "Sends every Monday at 09:00, next: Mon
// 09:00" – or why Schedule is off. The next run is asked by the composer (schedule-next.ts) and handed in.
// Owns: the block. Never: the text, the send or the form → spec step (schedule-form.ts, schedule-mode.ts).

import { Icon } from '../../lib/ui.tsx';
import { Segmented } from '../../settings/controls.tsx';
import { whenText } from '../details/Schedules.tsx';
import { patchForm } from './schedule-mode.ts';
import type { ScheduleMode } from './schedule-mode.ts';
import type { NextRun } from './schedule-next.ts';
import { ruleWords } from './schedule-rule.ts';
import { quickPicks, scheduleSpec, todayIn, UNITS } from './schedule-form.ts';
import type { ScheduleForm } from './schedule-form.ts';

const DAYS = [{ day: 1, letter: 'M', name: 'Monday' }, { day: 2, letter: 'T', name: 'Tuesday' }, { day: 3, letter: 'W', name: 'Wednesday' },
  { day: 4, letter: 'T', name: 'Thursday' }, { day: 5, letter: 'F', name: 'Friday' }, { day: 6, letter: 'S', name: 'Saturday' }, { day: 0, letter: 'S', name: 'Sunday' }];

export function ScheduleBar(props: { conversationId: string; mode: ScheduleMode; next: NextRun; note?: string; onLeave: () => void }) {
  const { conversationId, mode, next, note, onLeave } = props;
  const { form } = mode;
  const set = (patch: Partial<ScheduleForm>) => patchForm(conversationId, patch);
  const now = Date.now();
  const built = scheduleSpec(form, now);

  let line: string;
  let tone: 'muted' | 'warn' | 'error' = 'muted';
  if (note) { line = note; tone = 'warn'; }
  else if ('error' in built) { line = built.error; tone = built.soft ? 'muted' : 'error'; }
  else if (next.error) { line = next.error; tone = 'error'; }
  else line = `${mode.edit ? 'Editing · ' : ''}Sends ${ruleWords(built.spec, { tz: form.tz, now })}${next.at ? `, next: ${whenText(next.at, now)}` : ''}`;

  const toggleDay = (day: number) => set({ days: form.days.includes(day) ? form.days.filter((entry) => entry !== day) : [...form.days, day] });
  const text = (field: 'date' | 'time' | 'clock' | 'cron' | 'every' | 'start' | 'end') => (event: Event) => set({ [field]: (event.currentTarget as HTMLInputElement).value });

  return (
    <div class="schedule-bar" role="group" aria-label="Schedule" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onLeave(); } }}>
      <div class="schedule-row">
        <Segmented label="When" value={form.kind} onChange={(kind) => set({ kind })} options={[{ value: 'once', label: 'Once' }, { value: 'repeat', label: 'Repeat' }]} />
        {form.kind === 'repeat' && <Segmented label="Repeat" value={form.repeat} onChange={(repeat) => set({ repeat })}
          options={[{ value: 'days', label: 'Days' }, { value: 'every', label: 'Interval' }, { value: 'cron', label: 'Advanced' }]} />}
        <button type="button" class="icon-button small schedule-close" aria-label="Leave schedule mode" title="Back to a normal message (Esc)" onClick={onLeave}><Icon name="x" size={16} /></button>
      </div>

      <div class="schedule-row">
        {form.kind === 'once' && <>
          <input type="date" class="input schedule-date" aria-label="Date" value={form.date} min={todayIn(now, form.tz)} onInput={text('date')} />
          <input type="time" class="input schedule-time" aria-label="Time" value={form.time} onInput={text('time')} />
        </>}
        {form.kind === 'repeat' && form.repeat === 'every' && <>
          <span class="schedule-label">Every</span>
          <input type="number" class="input schedule-number" aria-label="Every" min={1} step={1} inputMode="numeric" value={form.every} onInput={text('every')} />
          <select class="select schedule-unit" aria-label="Unit" value={form.unit} onChange={(event) => set({ unit: (event.currentTarget as HTMLSelectElement).value as ScheduleForm['unit'] })}>
            {UNITS.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
          </select>
        </>}
        {form.kind === 'repeat' && form.repeat === 'days' && <>
          <div class="schedule-days" role="group" aria-label="Days">
            {DAYS.map(({ day, letter, name }) => (
              <button key={day} type="button" class="schedule-day" aria-label={name} title={name} aria-pressed={form.days.includes(day)} onClick={() => toggleDay(day)}>{letter}</button>
            ))}
          </div>
          <span class="schedule-label">at</span>
          <input type="time" class="input schedule-time" aria-label="Time" value={form.clock} onInput={text('clock')} />
        </>}
        {form.kind === 'repeat' && form.repeat === 'cron' && <>
          <span class="schedule-label">Cron</span>
          <input type="text" class="input schedule-cron" aria-label="Cron" placeholder="0 9 * * 1" spellcheck={false} autocomplete="off" value={form.cron} onInput={text('cron')} />
        </>}
      </div>

      <div class="schedule-row schedule-extra">
        {form.kind === 'once' && quickPicks(now, form.tz).map((pick) => (
          <button key={pick.key} type="button" class="chip schedule-pick" disabled={pick.disabled} onClick={() => set({ date: pick.date, time: pick.time })}>{pick.label}</button>
        ))}
        {form.kind === 'repeat' && <>
          <label class="schedule-field" title="Optional: the first run is not before this">
            <span class="schedule-label">Starts</span>
            <input type="datetime-local" class="input schedule-start" aria-label="Starts" value={form.start} onInput={text('start')} />
          </label>
          <label class="schedule-field" title="Optional: the last day it runs">
            <span class="schedule-label">Ends</span>
            <input type="date" class="input schedule-end" aria-label="Ends" value={form.end} min={todayIn(now, form.tz)} onInput={text('end')} />
          </label>
          <button type="button" class={`chip schedule-clear${form.start || form.end ? '' : ' idle'}`} tabIndex={form.start || form.end ? 0 : -1}
            onClick={() => set({ start: '', end: '' })}>Clear</button>
        </>}
      </div>

      <p class={`schedule-line ${tone}`} role="status">{line}</p>
    </div>
  );
}
