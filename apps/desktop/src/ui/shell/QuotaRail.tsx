// Quota badges in the rail (B-078, D17 – owner 06.11.2026: a circle, the 5-hour limit as the ring, the weekly share as the
// number, minutes to the 5-hour reset, the plan's name, the provider by colour only, smaller so four fit). One compact badge
// per plan, every part in a fixed slot so a reading that comes or goes moves nothing:
//   a ring – only when the plan reports a 5-hour window (lib/limits.ts fiveHourOf; some plans have none) – whose arc is the
//   5-hour share left in the provider's colour (the track alone once that reset passed), with the weekly % left in its
//   middle in the same colour; without a 5-hour window the number stands alone in the same spot;
//   one line with the minutes to the 5-hour reset ("42m", "2h 5m"; reserved and empty without one);
//   one line with the plan's name (the runtime's UsageSummary.name – a label of the person's own, else the e-mail's local
//   part, shared/model/plan-names.ts – else the label).
// Active rotation plan first, then by weekly share; max 4 + "+n". A stale reading dims the badge.
// Details on hover/focus/click: every limit window with bar, share left and "resets in 42 min", the next rotation plan and
// – B-044 – a Codex plan's banked resets with the next one's expiry (labels and shares from the shared helper, lib/limits.ts).
// Opening the details asks the runtime for fresh readings (lib/usage-refresh.ts: usage.list refresh – with
// the Codex reset details; the runtime's account monitor shares its 15 s Codex / 60 s Claude cadence;
// usage.updated updates the badges).
// The window coming to the front is an activity signal (plain usage.list, at most once a minute): the
// monitor then re-reads plans that are due. A runtime timer covers usage in other apps too.
// Owns: the badges and the details card. Never: invents values (unknown or a passed reset → "–"), polls, or names the provider in text.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { UsageSummary } from '../../shared/model/providers.ts';
import { Popover } from '../lib/ui.tsx';
import { usage } from '../lib/store.ts';
import { PROVIDER_NAMES } from '../settings/providers.ts';
import { rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { countdown, fiveHourOf, leftOf, nextCredit, resetCount, resetsAvailableText, shortWait, windowLabel } from '../lib/limits.ts';
import { USAGE_REFRESH_MS, refreshUsage } from '../lib/usage-refresh.ts';

let signalledAt = 0;
/** Badges shown before "+n". */
const VISIBLE = 4;
/** The ring: radius and stroke in a 28 px box. */
const RING_R = 12.5;
const RING_C = 2 * Math.PI * RING_R;
/** Colours of providers other than Claude and Codex (tokens.css --provider-other-0…3). */
const OTHER_COLOURS = 4;

/** The window came to the front: the person is here (the runtime counts usage.list as activity). */
function signalActivity(): void {
  const now = Date.now();
  if (document.visibilityState !== 'visible' || now - signalledAt < USAGE_REFRESH_MS || !can('usage.list')) return;
  signalledAt = now;
  rpc.call('usage.list').then((list) => { usage.value = list; }, () => { /* the last readings stay */ });
}

/** The plan's short name: the runtime's, else its label, else the provider's name. */
export function planName(entry: Pick<UsageSummary, 'name' | 'label' | 'provider'>): string {
  return entry.name?.trim() || entry.label.trim() || PROVIDER_NAMES[entry.provider] || entry.provider;
}

/** The weekly share left: the runtime's reading, undefined while unknown or once its reset passed. */
export function weeklyOf(entry: Pick<UsageSummary, 'weeklyRemainingPercent' | 'weeklyResetsAt'>, now = Date.now()): number | undefined {
  if (entry.weeklyRemainingPercent === undefined || (entry.weeklyResetsAt !== undefined && entry.weeklyResetsAt <= now)) return undefined;
  return Math.max(0, Math.min(100, Math.round(entry.weeklyRemainingPercent)));
}

/** The provider's colour class: claude, codex, or one of the fixed palette for any other provider (stable per provider id). */
export function providerClass(provider: string): string {
  if (provider === 'claude' || provider === 'anthropic') return 'claude';
  if (provider === 'codex' || provider === 'openai') return 'codex';
  let sum = 0;
  for (const char of provider) sum += char.charCodeAt(0);
  return `other other-${sum % OTHER_COLOURS}`;
}

function sorted(list: UsageSummary[]): UsageSummary[] {
  const now = Date.now();
  return list
    .filter((entry) => entry.weeklyRemainingPercent !== undefined || entry.limits?.windows.length)
    .sort((a, b) => Number(b.active) - Number(a.active) || (weeklyOf(b, now) ?? -1) - (weeklyOf(a, now) ?? -1));
}

function Details(props: { entry: UsageSummary; next?: UsageSummary }) {
  const { entry, next } = props;
  const limits = entry.limits;
  const now = Date.now();
  const resets = resetCount(limits?.resets);
  return (
    <div class={`usage-card provider-${providerClass(entry.provider)}`}>
      <h4>{planName(entry)}</h4>
      {limits?.windows.map((window) => {
        const left = leftOf(window, now);
        return (
          <div class="usage-window" key={window.name}>
            <div class="usage-row"><span>{windowLabel(window.name)}</span><span class="tabular">{left === undefined ? '–' : `${left}% left`}</span></div>
            <div class="usage-bar"><span style={{ width: `${left ?? 0}%` }} /></div>
            <p class="usage-reset">{!window.resetsAt || left === undefined ? '–' : `resets ${countdown(window.resetsAt, now)}`}</p>
          </div>
        );
      })}
      {resets !== undefined && <p class="usage-reset">{resetsAvailableText(resets, nextCredit(limits?.resets, now))}</p>}
      {entry.active && next && <p class="usage-reset">Next: {planName(next)}</p>}
    </div>
  );
}

/** The 5-hour ring (track + the share left) – drawn only for a plan with a 5-hour window. */
function Ring(props: { left?: number }) {
  const arc = props.left === undefined ? 0 : (props.left / 100) * RING_C;
  return (
    <svg class="usage-ring" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">
      <circle class="usage-ring-track" cx="14" cy="14" r={RING_R} />
      {arc > 0 && <circle class="usage-ring-arc" cx="14" cy="14" r={RING_R} stroke-dasharray={`${arc} ${RING_C}`} transform="rotate(-90 14 14)" />}
    </svg>
  );
}

function Badge(props: { entry: UsageSummary; next?: UsageSummary }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { entry } = props;
  const now = Date.now();
  const weekly = weeklyOf(entry, now);
  const five = fiveHourOf(entry.limits, now);
  const wait = five?.resetsAt !== undefined ? shortWait(five.resetsAt, now) : undefined;
  const name = planName(entry);
  const label = [
    `${name}: ${weekly === undefined ? 'weekly share unknown' : `${weekly}% weekly left`}`,
    five ? (five.left === undefined ? '5-hour limit reset' : `${five.left}% of the 5-hour limit left${five.resetsAt ? `, resets ${countdown(five.resetsAt, now)}` : ''}`) : '',
    entry.limits?.stale ? 'stale reading' : '',
  ].filter(Boolean).join(', ');
  const show = () => { clearTimeout(closeTimer.current); if (!open) refreshUsage(); setOpen(true); };
  const hide = () => { if (!pinned) closeTimer.current = setTimeout(() => setOpen(false), 150); };
  return (
    <>
      <button
        ref={ref}
        type="button"
        class={`usage-badge provider-${providerClass(entry.provider)}${entry.active ? ' active' : ''}${entry.limits?.stale ? ' stale' : ''}`}
        aria-expanded={open}
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => { refreshUsage(); setPinned(!pinned); setOpen(true); }}
      >
        <span class="usage-dial">
          {five && <Ring left={five.left} />}
          <span class="usage-value tabular">{weekly === undefined ? '–' : `${weekly}%`}</span>
        </span>
        <span class="usage-wait tabular">{wait ?? ''}</span>
        <span class="usage-name">{name}</span>
      </button>
      <Popover anchor={ref.current} open={open} onClose={() => { setOpen(false); setPinned(false); }} placement="right-end" width={280} class="usage-popover" label={name}>
        <div onMouseEnter={show} onMouseLeave={hide}><Details entry={entry} next={props.next} /></div>
      </Popover>
    </>
  );
}

export function QuotaRail() {
  useEffect(() => {
    signalledAt = Date.now(); // the shell's load just read usage
    const front = () => signalActivity(); // per instance: the rail and the phone menu may both be mounted
    document.addEventListener('visibilitychange', front);
    window.addEventListener('focus', front);
    return () => { document.removeEventListener('visibilitychange', front); window.removeEventListener('focus', front); };
  }, []);
  const list = sorted(usage.value);
  if (!list.length) return null;
  const visible = list.slice(0, VISIBLE);
  const rest = list.length - visible.length;
  const next = list.find((entry) => !entry.active);
  return (
    <div class="usage-stack">
      {visible.map((entry) => <Badge key={entry.accountId} entry={entry} next={next} />)}
      {rest > 0 && <span class="usage-more tabular" title={list.slice(VISIBLE).map(planName).join(', ')}>+{rest}</span>}
    </div>
  );
}
