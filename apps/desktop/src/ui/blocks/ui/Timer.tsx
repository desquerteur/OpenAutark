// `timer` ask widget: a reminder or countdown for the human. Shows the label, the target time
// (absolute `at` or a duration) with a quiet live countdown, Done, and Snooze (F03: a small menu –
// 10 min, 1 h, tomorrow at the start of the working day (B-041: settings.day.workStart across the
// 04:00 day boundary, tasks/todo-time.ts snoozeChoices) – that lets the to-do wait and ring again;
// offered only when a to-do stands behind the widget).
// The ring itself is owned by the runtime scheduler (desktop + phone push), not this widget.
// Answer: {event: 'done'}. Owns: the display. Never: schedules anything itself.

import { useEffect, useRef, useState } from 'preact/hooks';
import { parseDuration } from '../../../shared/blocks/coerce.ts';
import { Button, Icon, Menu } from '../../lib/ui.tsx';
import { fullDate, relative, time } from '../../lib/format.ts';
import { settings } from '../../lib/store.ts';
import { daySettingsOf } from '../../../shared/model/day-settings.ts';
import { snoozeChoices } from '../../tasks/todo-time.ts';
import { Inline } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { s } from './util.ts';

const REPEAT_LABEL: Record<string, string> = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

/** "1 h 30 min", "45 s" – compact human duration. */
export function durationText(ms: number): string {
  const total = Math.round(ms / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} d`);
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (!d && !h && sec) parts.push(`${sec} s`);
  return parts.join(' ') || '0 s';
}

/** Re-renders once per minute (or per second in the last minute) while a target is set. */
function useTick(target: number | undefined): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!target) return;
    const left = target - Date.now();
    if (left < -60_000) return; // long past: nothing left to count
    const delay = left > 0 && left <= 60_000 ? 1000 : 60_000 - (Date.now() % 60_000);
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [target, now]);
  return now;
}

export function Timer(props: AskWidgetProps) {
  const { block } = props;
  const anchor = useRef<HTMLSpanElement>(null);
  const [menu, setMenu] = useState(false);
  const at = s(block.at) ? Date.parse(s(block.at)) : NaN;
  const target = Number.isFinite(at) ? at : undefined;
  const duration = !target && s(block.duration) ? parseDuration(s(block.duration)) : undefined;
  const now = useTick(target);
  const left = target ? target - now : undefined;
  const repeat = REPEAT_LABEL[s(block.repeat)];

  return (
    <div class="w-timer">
      <div class="w-timer-main">
        <Icon name="clock" size={20} />
        <div class="w-timer-text">
          <div class="w-question"><Inline text={s(block.label)} /></div>
          <div class="w-timer-when tabular">
            {target !== undefined && (
              <time dateTime={new Date(target).toISOString()} title={fullDate(target)}>
                {time(target)}{left !== undefined && Math.abs(left) < 7 * 86_400_000 ? ` · ${left > 0 && left < 3_600_000 ? `in ${durationText(left)}` : relative(target, now)}` : ''}
              </time>
            )}
            {duration !== undefined && <span>{durationText(duration)}</span>}
            {repeat && <span class="w-timer-repeat">{repeat}</span>}
          </div>
        </div>
      </div>
      <div class="w-actions">
        <Button variant="primary" busy={props.busy} onClick={() => void props.submit({ event: 'done' })}>Done</Button>
        {props.snooze && (
          <span ref={anchor}>
            <Button variant="secondary" disabled={props.busy} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Snooze</Button>
          </span>
        )}
      </div>
      {props.snooze && (
        <Menu anchor={anchor.current} open={menu} onClose={() => setMenu(false)} placement="bottom-start" width={200} label="Snooze"
          sections={[{ items: snoozeChoices(Date.now(), daySettingsOf(settings.value ?? undefined).workStart).map((choice) => ({ label: choice.label, icon: 'clock' as const, onSelect: () => void props.snooze!(choice.until) })) }]} />
      )}
    </div>
  );
}
