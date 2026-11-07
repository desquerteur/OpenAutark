// B-055 Q5: the feedback tour's player – a "video" made of code. A poster frame (the filled example
// scene) with a big Play button, so people see it is a video; then the timeline (timeline.ts) runs on
// requestAnimationFrame only while playing – nothing runs while paused, ended or hidden (a hidden window
// pauses it and resumes it when shown again). Controls in one fixed bar that never shifts: play/pause,
// back/forward 5 s, the time, a scrubber with chapter ticks (click or drag to seek; the scene follows
// live), keys Space/K, ←/→, Home/End; "Skip" (first run, with the caller's "Connect to my other device" beside it) or ×
// (dialog) top right, and at the end a card
// with "Continue" and "Watch again". The scene keeps its aspect and is scaled to fit its box (CSS
// transform), at every window size from 640×480 to phone width.
// Used by the replay dialog (TourDialog.tsx), which starts at its poster on every opening. AF-002: the first run no
// longer hosts it; the page mode (Skip, Connect, keeping its place over a remount) stays for a page that does.
// Owns: playback state, the controls and the scene's fit. Never: the story (timeline.ts), the drawing
// (Scene.tsx) or what Continue leads to (the caller's onDone).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { TourIcon } from './icons.tsx';
import { fitScale, formatTime, keyAction, nextTime, stepTime, timeAt } from './player-model.ts';
import { Scene } from './Scene.tsx';
import { CHAPTERS, DURATION, clampTime, stateAt } from './timeline.ts';

export const TOUR_TITLE = 'How to send feedback';
export const END_TEXT = 'Only the Teydra team can read your feedback – it is encrypted on your PC.';

const percent = (t: number) => `${((t / DURATION) * 100).toFixed(3)}%`;

/** Where the first run's player was when it unmounted (the layer mounts again on a layout change). */
const kept = { t: 0, started: false, playing: false };

/** `onConnect` (first run): the text button "Connect to my other device" beside Skip. */
export function TourPlayer(props: { mode: 'page' | 'dialog'; onDone: () => void; onConnect?: () => void }) {
  const page = props.mode === 'page';
  const [t, setT] = useState(() => (page ? kept.t : 0));
  const [playing, setPlaying] = useState(() => page && kept.playing);
  const [started, setStarted] = useState(() => page && kept.started);
  const [scale, setScale] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const playButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const time = useRef(0);
  const live = useRef(false);
  const resume = useRef(false); // hidden while playing: play again once shown
  const scrub = useRef<{ resume: boolean } | null>(null);
  const begun = useRef(started);
  const finished = useRef(false);
  time.current = t;
  live.current = playing;
  begun.current = started;
  const state = stateAt(t);

  // Frames only while playing; a long gap (hidden, busy) advances at most one short step. The effect's cleanup
  // runs only after the next paint, so a frame already asked for checks `live` itself: paused means no more time.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (!live.current) return;
      const next = nextTime(time.current, now - last, DURATION);
      last = now;
      time.current = next;
      setT(next);
      if (next >= DURATION) { setPlaying(false); return; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const stop = () => { live.current = false; setPlaying(false); };

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        if (live.current) { resume.current = true; stop(); }
      } else if (resume.current) {
        resume.current = false;
        setPlaying(true);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => setScale(fitScale(element.clientWidth, element.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    (playButton.current ?? root.current)?.focus({ preventScroll: true });
    return () => { if (page && !finished.current) Object.assign(kept, { t: time.current, started: begun.current, playing: live.current }); };
  }, []);
  // The end card reached by playing takes the focus (Enter continues).
  const endOn = state.end.on;
  useEffect(() => { if (endOn && live.current) continueButton.current?.focus({ preventScroll: true }); }, [endOn]);

  const seek = (next: number) => { const value = clampTime(next); time.current = value; setT(value); setStarted(true); };
  const play = () => { if (time.current >= DURATION) seek(0); setStarted(true); setPlaying(true); };
  const toggle = () => { if (live.current) stop(); else play(); };
  const again = () => { seek(0); setPlaying(true); };
  const done = () => { finished.current = true; Object.assign(kept, { t: 0, started: false, playing: false }); props.onDone(); };
  const seekAt = (x: number, element: HTMLElement) => { const rect = element.getBoundingClientRect(); seek(timeAt(x, rect.left, rect.width, DURATION)); };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const action = keyAction(event.key, Boolean(target?.closest('button')));
    if (!action || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (action === 'toggle') toggle();
    else seek(stepTime(action, time.current, DURATION));
  };

  const phase = !started ? 'poster' : state.end.on ? 'ended' : playing ? 'playing' : 'paused';
  const chapter = CHAPTERS[state.chapter]!;
  return (
    // tabIndex -1: a click on the scene focuses the player, so the keys keep working after it
    <div ref={root} class={`tour-player ${props.mode}`} tabIndex={-1} data-phase={phase} data-time={Math.round(t)} onKeyDown={onKeyDown}>
      <div class="tour-top">
        <span class="tour-title">{TOUR_TITLE}</span>
        {props.mode === 'page'
          ? (
            <span class="tour-top-actions">
              {props.onConnect && <button type="button" class="button ghost tour-connect" onClick={props.onConnect}>Connect to my other device</button>}
              <button type="button" class="button ghost tour-skip" onClick={done}>Skip</button>
            </span>
          )
          : <button type="button" class="icon-button tour-close" aria-label="Close" onClick={done}><TourIcon name="x" size={18} /></button>}
      </div>
      <div class="tour-stage-room">
        <div class="tour-stage-box" ref={box} onClick={() => { if (!state.end.on) toggle(); }}>
          <div class="tour-stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
            <Scene state={state} />
          </div>
          {!started && (
            <div class="tour-poster">
              <button type="button" class="tour-play" ref={playButton} aria-label="Play" onClick={(event) => { event.stopPropagation(); play(); root.current?.focus({ preventScroll: true }); }}>
                <TourIcon name="play" size={46} />
              </button>
            </div>
          )}
          {state.end.on && (
            <div class="tour-end" style={{ opacity: String(Math.min(1, state.end.age / 300)) }} onClick={(event) => event.stopPropagation()}>
              <p class="tour-end-text">{END_TEXT}</p>
              <div class="tour-end-actions">
                <button type="button" class="button secondary" onClick={again}>Watch again</button>
                <button type="button" class="button primary" ref={continueButton} onClick={done}>Continue</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <p class="tour-caption" aria-live="polite">{state.caption}</p>
      <div class="tour-controls">
        <button type="button" class="icon-button tour-control" aria-label={playing ? 'Pause' : 'Play'} onClick={toggle}>
          <TourIcon name={playing ? 'pause' : 'play'} size={18} />
        </button>
        <button type="button" class="icon-button tour-control tour-jump" aria-label="Back 5 seconds" onClick={() => seek(stepTime('back', time.current, DURATION))}>
          <TourIcon name="back" size={22} /><span class="tour-jump-n" aria-hidden="true">5</span>
        </button>
        <button type="button" class="icon-button tour-control tour-jump" aria-label="Forward 5 seconds" onClick={() => seek(stepTime('forward', time.current, DURATION))}>
          <TourIcon name="forward" size={22} /><span class="tour-jump-n" aria-hidden="true">5</span>
        </button>
        <span class="tour-time">{formatTime(t)} / {formatTime(DURATION)}</span>
        <div
          class="tour-scrubber" role="slider" tabIndex={0} aria-label="Position"
          aria-valuemin={0} aria-valuemax={Math.round(DURATION / 1000)} aria-valuenow={Math.round(t / 1000)}
          aria-valuetext={`${formatTime(t)} of ${formatTime(DURATION)} – ${chapter.title}`}
          onPointerDown={(event) => {
            const element = event.currentTarget as HTMLElement;
            element.setPointerCapture?.(event.pointerId);
            scrub.current = { resume: live.current };
            stop();
            seekAt(event.clientX, element);
          }}
          onPointerMove={(event) => { if (scrub.current) seekAt(event.clientX, event.currentTarget as HTMLElement); }}
          onPointerUp={() => { const was = scrub.current; scrub.current = null; if (was?.resume && time.current < DURATION) setPlaying(true); }}
          onPointerCancel={() => { scrub.current = null; }}
        >
          <span class="tour-track"><span class="tour-fill" style={{ transform: `scaleX(${(t / DURATION).toFixed(4)})` }} /></span>
          {CHAPTERS.slice(1).map((entry) => <span key={entry.title} class="tour-tick" style={{ left: percent(entry.at) }} title={entry.title} />)}
          <span class="tour-knob" style={{ left: percent(t) }} />
        </div>
      </div>
    </div>
  );
}
