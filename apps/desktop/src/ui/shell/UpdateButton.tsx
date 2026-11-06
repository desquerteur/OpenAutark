// Update control in the rail (above the quotas) and, with `compact`, in the top row of narrow
// desktop windows (MobileShell: a fixed cell on tab views and a pushed agent; above a chat or a
// settings section a ready update is a notice-band line instead). Visible only when relevant
// (update-control.ts):
//   available   → blue circle with download arrow ("Update"; "Download" opens the download page
//                 where the app cannot install by itself, e.g. macOS)
//   downloading → value-bound ring with the real percentage + black pill tooltip
//   downloaded  → check; click shows Restart / Later (and the auto-restart countdown)
//   installing  → spinner; the pill "Autark is installing 0.x and opens again by itself in about a minute" stays
//                 visible without hover until the window closes (compact: the native title)
//   error       → retry only for a failed download/open of a verified update; check failures stay quiet
// Hidden in development, idle, checking and current states, and without the desktop bridge
// (PWA). The compact item uses the native title instead of the side pill.
// Owns: the control. Never: checks for updates itself (main does, see UpdatesBridge).

import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon, Popover, Ring, Spinner } from '../lib/ui.tsx';
import { systemInfo, updateState } from '../lib/store.ts';
import { bridge } from '../lib/platform.ts';
import { toastError } from '../lib/toasts.ts';
import { updateControl } from './update-control.ts';

function useNow(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000); // only while a countdown is shown
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

async function run(action: 'apply' | 'defer'): Promise<void> {
  try {
    await bridge?.updates?.[action]();
  } catch (error) {
    toastError(error, 'Update failed');
  }
}

export function UpdateButton(props: { compact?: boolean }) {
  const state = updateState.value;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const countdown = state?.status === 'downloaded' && state.restartAt ? state.restartAt : 0;
  const now = useNow(!!countdown);
  useEffect(() => { if (countdown) setOpen(true); }, [countdown]);
  const view = updateControl(state, systemInfo.value?.platform);
  if (!state || !view || !bridge?.updates) return null;
  const { status } = state;
  const { glyph, label, percent } = view;
  const seconds = countdown ? Math.max(0, Math.ceil((countdown - now) / 1000)) : 0;
  const installing = status === 'installing'; // the pill stays until the window closes: the app comes back by itself

  return (
    <div
      class={`update-control${props.compact ? ' compact' : ''}`}
      onMouseEnter={props.compact ? undefined : () => setHover(true)}
      onMouseLeave={props.compact ? undefined : () => setHover(false)}
    >
      <button
        ref={ref}
        type="button"
        class={`update-button status-${status}`}
        aria-label={label}
        title={props.compact ? label : undefined}
        disabled={view.action === null}
        onClick={() => { if (view.action === 'apply') void run('apply'); else if (view.action === 'menu') setOpen(!open); }}
      >
        {glyph === 'download' && <Icon name="download-simple" size={21} />}
        {glyph === 'progress' && <Ring value={percent} size={36} stroke={3}><span class="tabular">{percent}%</span></Ring>}
        {glyph === 'ready' && <Icon name="check" size={20} />}
        {glyph === 'restarting' && <Spinner size={20} label="Installing" />}
        {glyph === 'retry' && <Icon name="arrow-clockwise" size={20} />}
      </button>
      {!props.compact && (hover || installing) && !open && <span class="rail-tooltip" role={installing ? 'status' : 'tooltip'}>{label}</span>}
      <Popover anchor={ref.current} open={open && status === 'downloaded'} onClose={() => setOpen(false)} placement={props.compact ? 'bottom-end' : 'right-end'} class="update-popover" label="Update">
        <p class="update-title">{state.availableVersion ? `Version ${state.availableVersion}` : 'Update ready'}</p>
        {countdown > 0 && <p class="muted tabular">Restarting in {seconds} s</p>}
        {countdown === 0 && state.message && <p class="muted">{state.message}</p>}
        <div class="update-actions">
          <button type="button" class="button ghost" onClick={() => { setOpen(false); void run('defer'); }}>Later</button>
          <button type="button" class="button primary" onClick={() => { setOpen(false); void run('apply'); }}>Restart</button>
        </div>
      </Popover>
    </div>
  );
}
