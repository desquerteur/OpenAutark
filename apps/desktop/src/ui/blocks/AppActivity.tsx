// "Activity" disclosure of one ```app mini-tool (F08): a quiet "Activity" line under the frame at
// its right edge (blocks.css) – outside the app's own area, so it never covers the app's controls –
// opens a popover aligned to that edge with the frame's last bridge calls from the call ring
// (app-calls.ts activityRows): what the app did, the bridge name it used, size, how it ended and
// when. The rows are read before the popover first
// renders (so it is placed with its real height) and again on the ring's change events while it
// is open, coalesced to one read per animation frame; the popover places itself again as it grows.
// Owns: the disclosure's markup. Never: shows payload content (the ring keeps none) or changes
// anything – it only reads.

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { fileSize, fullDate, locale } from '../lib/format.ts';
import { Popover } from '../lib/ui.tsx';
import { activityRows, appCalls } from './app-calls.ts';
import type { ActivityRow, CallResult } from './app-calls.ts';

const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const RESULT_TEXT: Record<CallResult, string> = {
  pending: 'running', ok: '', error: 'failed', limited: 'refused: too many calls', 'too-large': 'refused: too large', invalid: 'not understood',
};

function details(row: ActivityRow): string {
  const parts = [row.name, row.bytes < 0 ? 'size unknown' : fileSize(row.bytes)];
  if (row.ms !== undefined && row.ms > 0) parts.push(`${row.ms} ms`);
  if (RESULT_TEXT[row.result]) parts.push(RESULT_TEXT[row.result]);
  return parts.join(' · ');
}

export function AppActivity(props: { frame: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const open = anchor !== null;

  useEffect(() => {
    if (!open) return;
    let raf = 0;
    const read = () => { raf = 0; setRows(activityRows(appCalls, props.frame)); };
    const off = appCalls.subscribe(() => { if (!raf) raf = requestAnimationFrame(read); });
    read(); // a call logged between the click and this subscription is not missed
    return () => { off(); if (raf) cancelAnimationFrame(raf); };
  }, [open, props.frame]);

  const toggle = (event: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    if (open) { setAnchor(null); return; }
    setRows(activityRows(appCalls, props.frame));
    setAnchor(event.currentTarget);
  };

  return (
    <div class="app-frame-foot">
      <button type="button" class="text-button" aria-haspopup="dialog" aria-expanded={open} onClick={toggle}>Activity</button>
      <Popover anchor={anchor} open={open} onClose={() => setAnchor(null)} placement="bottom-end" width={340} class="app-activity" label="Mini-app activity">
        <div class="menu-title">{rows.length ? 'What this mini-app asked the app to do · names and sizes only' : 'This mini-app has not called the app yet.'}</div>
        {rows.length > 0 && (
          <div class="menu-section" role="list">
            {rows.map((row, index) => (
              <div key={index} class="menu-item" role="listitem">
                <span class="menu-label">
                  <span>{row.label}{row.count > 1 ? ` ×${row.count}` : ''}</span>
                  <small>{details(row)}</small>
                </span>
                <time class="menu-hint" dateTime={new Date(row.at).toISOString()} title={fullDate(row.at)}>{clock.format(row.at)}</time>
              </div>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
