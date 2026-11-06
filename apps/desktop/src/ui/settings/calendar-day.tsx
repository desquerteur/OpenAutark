// Settings › Calendar › My day (settings.day): working hours, the morning plan and its time, and the agents' schedules as
// a lane in My day's calendar. B-078 (D17): the buffer between blocks and "AI helps" stay settings.json keys for the AI
// without a row; keeping the PC awake is Settings › General "Keep the screen on while agents work". A phone may not change
// 'day' settings: it sees the values, read-only, with the usual PC note.
// Owns: these rows and their mapping onto settings.day. Never: invents options without effect.

import { daySettingsOf, type DaySettings } from '../../shared/model/day-settings.ts';
import { isOwner, PC_NOTE } from '../lib/session.ts';
import { settings, updateSettings } from '../lib/store.ts';
import { hoursProblem } from './calendar-model.ts';
import { act, Group, Row, TextField, Toggle } from './controls.tsx';

export function DayGroup() {
  const value = settings.value;
  if (!value) return null;
  const day = daySettingsOf(value);
  const locked = !isOwner();
  const save = (patch: Partial<DaySettings>) => act(() => updateSettings({ day: patch }), 'Could not save');
  const saveHours = (workStart: string, workEnd: string) => act(async () => {
    const problem = hoursProblem(workStart, workEnd);
    if (problem) throw new Error(problem);
    await updateSettings({ day: { workStart, workEnd } });
  }, 'Could not save');
  const toggle = (key: 'autoPlan' | 'agentLane', label: string) => (
    <Toggle label={label} checked={day[key]} disabled={locked} onChange={(on) => void save({ [key]: on })} />
  );
  return (
    <Group title="My day" hint={locked ? PC_NOTE : undefined}>
      <Row label="Working hours">
        <div class="set-inline">
          <TextField type="time" label="Work starts" value={day.workStart} disabled={locked} onCommit={(start) => void saveHours(start, day.workEnd)} />
          <span class="set-suffix">to</span>
          <TextField type="time" label="Work ends" value={day.workEnd} disabled={locked} onCommit={(end) => void saveHours(day.workStart, end)} />
        </div>
      </Row>
      <Row label="Plan my day automatically">
        <div class="set-inline">
          {/* always in its place – only disabled while the morning plan is off, so the switch never moves */}
          <TextField type="time" label="Plan at" value={day.planAt} disabled={locked || !day.autoPlan} onCommit={(planAt) => void save({ planAt })} />
          {toggle('autoPlan', 'Plan my day automatically')}
        </div>
      </Row>
      <Row label="Show agents' schedules">{toggle('agentLane', "Show agents' schedules")}</Row>
    </Group>
  );
}
