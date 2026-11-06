// Pane tab › Screen: the live picture of this PC while agents use the computer – one computer.preview
// at a time, every 2 s, only while this tab is shown and the window is visible and focused (it stops
// after an error a retry cannot fix). The line under it says who is using the PC and what they do,
// and while an agent uses it holds one Stop button (Resume in the same cell after a Stop).
// Owns: that loop and the line. Never: controls the screen or shows linked PCs.

import { useEffect, useState } from 'preact/hooks';
import { time } from '../lib/format.ts';
import { errorText, rpc, RpcError } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { Button, Spinner } from '../lib/ui.tsx';
import { computerActivity, resumeComputerUse, stopComputerUse, watchComputerActivity } from '../shell/computer-activity.ts';

const REFRESH_MS = 2000;

interface Shot { dataUrl: string; width: number; height: number; at: number }

const watching = () => document.visibilityState === 'visible' && document.hasFocus();

/** Errors a retry in 2 s cannot fix (no permission, nothing to show). */
function permanent(error: unknown): boolean {
  return error instanceof RpcError && (error.code === 'forbidden' || error.code === 'bad_request' || error.code === 'not_found');
}

export function ScreenView() {
  const [shot, setShot] = useState<Shot | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(watching);
  const computer = computerActivity.value;
  useEffect(() => {
    watchComputerActivity();
    const update = () => setActive(watching());
    window.addEventListener('focus', update); window.addEventListener('blur', update); document.addEventListener('visibilitychange', update);
    return () => { window.removeEventListener('focus', update); window.removeEventListener('blur', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  useEffect(() => {
    if (!active || !can('computer.preview')) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try { const next = await rpc.call('computer.preview', {}); if (!alive) return; setShot(next); setError(''); } catch (failed) {
        if (!alive) return;
        setError(errorText(failed));
        if (permanent(failed)) return;
      }
      if (alive) timer = setTimeout(() => void tick(), REFRESH_MS);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [active]);

  const running = Boolean(computer?.active && !computer.stopped);
  const status = !can('computer.preview') ? 'The screen is shown on this PC only.'
    : error || (computer?.stopped ? 'Computer use is stopped.' : running ? `${computer?.agent ?? 'An agent'} is using this PC${computer?.summary ? ` · ${computer.summary}` : ''}`
      : shot ? `${active ? 'Live' : 'Paused'} · ${time(shot.at)}` : '');
  return (
    <div class="pane-view pane-screen">
      <div class="pane-stage">
        {shot ? <img src={shot.dataUrl} width={shot.width} height={shot.height} alt="Screen of this PC" /> : !error && can('computer.preview') && <Spinner label="Loading the screen" />}
      </div>
      <div class="pane-foot">
        <span class="pane-foot-text" role="status">{status}</span>
        <span class="pane-foot-action">
          {can('computer.stop') && running && <Button variant="danger" onClick={() => void stopComputerUse()}>Stop</Button>}
          {can('computer.resume') && computer?.stopped && <Button onClick={() => void resumeComputerUse()}>Resume</Button>}
        </span>
      </div>
    </div>
  );
}
