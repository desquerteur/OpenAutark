// Small shared pieces of every task surface: the round status glyph (spinner only for a real
// running turn), the clamped notes (B-078; the verification mark is gone from the UI), the owner avatar (an
// agent's rounded square, a person's round one) or "Team" badge, the thin progress bar, the due
// text (a timer's ring time with its countdown in the last hour, F04), a snoozed to-do's line and the phone's ⋯ menu button.
// Owns: their markup and accessible labels. Never: data loading or actions.

import { useState } from 'preact/hooks';
import type { Task, TaskStatus } from '../../shared/model/tasks.ts';
import { Markdown } from '../blocks/markdown.tsx';
import { AgentAvatar, HumanAvatar, Icon, IconButton, Spinner } from '../lib/ui.tsx';
import type { MenuSection } from '../lib/ui.tsx';
import { openContextMenu } from '../lib/context-menu.tsx';
import { agentName, isMobile } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { fullDate, relative } from '../lib/format.ts';
import { durationText } from '../blocks/ui/Timer.tsx';
import { STATUS_LABELS, countdownMs, dueState, ownerOf, progressPercent, whenText } from './model.ts';

/** Notes longer than this (or than four lines) are clamped. */
const NOTES_CLAMP_CHARS = 320;

/** Round status circle (T2/T23): state by shape + icon, never by colour alone. */
export function StatusGlyph(props: { status: TaskStatus; running?: boolean; size?: number; label?: string }) {
  const size = props.size ?? 18;
  const label = props.label ?? (props.running ? 'Working now' : STATUS_LABELS[props.status]);
  if (props.running) {
    return <span class="task-glyph running" style={{ width: `${size}px`, height: `${size}px` }} title={label}><Spinner size={size - 2} label={label} /></span>;
  }
  const icon = props.status === 'done' ? 'check' : props.status === 'blocked' ? 'exclamation-mark' : props.status === 'cancelled' ? 'x' : props.status === 'waiting' ? 'clock' : null;
  return (
    <span class="task-glyph" data-status={props.status} style={{ width: `${size}px`, height: `${size}px` }} role="img" aria-label={label} title={label}>
      {icon && <Icon name={icon} size={Math.max(9, Math.round(size * 0.6))} />}
    </span>
  );
}

/** Notes the agents wrote: read-only, at most four lines until "Show all" (B-078: no huge text blocks per task). */
export function NotesClamp(props: { text: string }) {
  const [all, setAll] = useState(false);
  const text = props.text.trim();
  if (!text) return null;
  const long = text.length > NOTES_CLAMP_CHARS || text.split('\n').length > 4;
  return (
    <div class="task-notes-field">
      <Markdown text={text} class={`task-notes${long && !all ? ' clamped' : ''}`} />
      {long && <button type="button" class="text-button inline" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show less' : 'Show all'}</button>}
    </div>
  );
}

/**
 * Owner: agent avatar (→ agent view), a colleague's round avatar (→ their page, B-041), the human,
 * or a small "Team" badge. Pass `interactive={false}` inside row buttons (no nested buttons).
 */
export function OwnerBadge(props: { task: Pick<Task, 'assigneeKind' | 'assigneeId'>; size?: number; working?: boolean; withName?: boolean; interactive?: boolean }) {
  const owner = ownerOf(props.task);
  const size = props.size ?? 22;
  if (owner.kind === 'agent') {
    return (
      <span class="owner-badge" title={agentName(owner.id)}>
        <AgentAvatar agentId={owner.id} size={size} working={props.working} onClick={props.interactive === false ? undefined : () => go.agent(owner.id)} />
        {props.withName && <span class="owner-name">{agentName(owner.id)}</span>}
      </span>
    );
  }
  if (owner.kind === 'person') { // F-52: a colleague
    return (
      <span class="owner-badge" title={agentName(owner.id)}>
        <AgentAvatar agentId={owner.id} size={size} onClick={props.interactive === false ? undefined : () => go.person(owner.id)} />
        {props.withName && <span class="owner-name">{agentName(owner.id)}</span>}
      </span>
    );
  }
  if (owner.kind === 'human') {
    return (
      <span class="owner-badge" title="You">
        <HumanAvatar size={size} />
        {props.withName && <span class="owner-name">You</span>}
      </span>
    );
  }
  return <span class="owner-badge team" title="Team"><Icon name="users-three" size={Math.max(12, size - 8)} /><span class="owner-name">Team</span></span>;
}

/** Thin progress bar ("6 of 10" is written next to it by the caller). */
export function ProgressBar(props: { done: number; total: number; label?: string }) {
  const value = progressPercent(props);
  return (
    <span class="task-bar" role="progressbar" aria-valuemin={0} aria-valuemax={props.total} aria-valuenow={props.done} aria-label={props.label ?? 'Progress'}>
      <span class="task-bar-value" style={{ width: `${value}%` }} />
    </span>
  );
}

/** A ring time: "17:00 · in 5 min" in its last hour, "17:00 · 2 minutes ago" once past, else "Tomorrow 09:00". */
function ringText(at: number, now: number): string {
  const left = countdownMs(at, now);
  if (left !== undefined) return `${whenText(at, now)} · in ${durationText(left)}`;
  return at <= now ? `${whenText(at, now)} · ${relative(at, now)}` : whenText(at, now);
}

/**
 * Due time as relative text ("in 3 hours"), overdue in the warning tone. With `timer` (F04) it is
 * a reminder's ring time as a clock time with the quiet countdown of its last hour (ringText).
 */
export function DueText(props: { dueAt: number | undefined; now?: number; timer?: boolean }) {
  if (props.dueAt === undefined) return null;
  const now = props.now ?? Date.now();
  const state = dueState(props.dueAt, now);
  const text = props.timer ? ringText(props.dueAt, now)
    : state === 'overdue' ? `Overdue · ${relative(props.dueAt, now)}` : relative(props.dueAt, now);
  return (
    <time class={`due-text ${state}${props.timer ? ' tabular' : ''}`} dateTime={new Date(props.dueAt).toISOString()}
      title={`${props.timer ? 'Rings' : 'Due'} ${fullDate(props.dueAt)}`}>
      {text}
    </time>
  );
}

/** A snoozed to-do's line: "Snoozed until 17:10" when its ring is known (tasks/todo-time.ts snoozeEnd), else "Snoozed". */
export function SnoozedText(props: { until: number | undefined; now: number }) {
  if (props.until === undefined) return <span class="due-text snoozed">Snoozed</span>;
  return (
    <time class="due-text snoozed tabular" dateTime={new Date(props.until).toISOString()} title={`Rings again ${fullDate(props.until)}`}>
      {`Snoozed until ${whenText(props.until, props.now)}`}
    </time>
  );
}

/** ⋯ opening the object's menu under the button – on the phone only (a mouse has the right click, a finger the long press). */
export function MoreButton(props: { build: () => MenuSection[] }) {
  if (!isMobile.value) return null;
  const open = (event: MouseEvent) => {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(box.right, box.bottom, props.build());
  };
  return <IconButton icon="dots-three" label="More" size="small" aria-haspopup="menu" onClick={open} />;
}
