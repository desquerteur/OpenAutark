// AF-002: the spotlight overlay of the app tour and the first-visit hints (state: spotlight.ts `spot`). A native modal
// <dialog> in the top layer: the rest of the window is inert (clicks never reach the dimmed app, the focus stays in the
// bubble) and the person's native browser pages hide while it is open (workspace/native-surface.ts). An SVG mask dims
// the window and cuts out the target's box (spotlight-geometry.ts holeFor), a ring marks it, and the bubble beside it
// (placeBubble – a sheet at the bottom on a narrow window, centred without a target) holds the progress "3 / 12", the
// title, one or two sentences, Skip, Back and Next (Done on the last step). The target is scrolled into view; the hole
// and the bubble follow resizes, scrolling and the target's own size (no timer loop). Keys: → and Enter next, ← back,
// Esc skips. The text is announced (aria-live); motion follows prefers-reduced-motion (spotlight.css).
// Owns: this markup, its measuring and its keys. Never: which step comes next or what is saved (spotlight.ts).

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../lib/ui.tsx';
import { isMobile } from '../lib/store.ts';
import { SHEET_BELOW, holeFor, inView, placeBubble, type Box, type Placement } from './spotlight-geometry.ts';
import { progressLabel, progressText } from './spotlight-model.ts';
import { hintToTour, spot, spotBusy, tourBack, tourExtra, tourNext, tourSkip, watchSpotlight, type SpotView } from './spotlight.ts';

/** Mounted once by the shell: starts the watcher and draws the overlay while something is shown. */
export function SpotlightHost() {
  useEffect(() => watchSpotlight(), []);
  const view = spot.value;
  return view ? <SpotlightDialog view={view} /> : null;
}

const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
const boxOf = (element: Element): Box => { const rect = element.getBoundingClientRect(); return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }; };
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Layout { hole: Box | null; place: Placement; view: { width: number; height: number } }

function SpotlightDialog(props: { view: SpotView }) {
  const { view } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const busy = spotBusy.value;
  const tour = view.mode === 'tour';

  useLayoutEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  // Measure: the target's box → the hole, the bubble's size → its place. Again on resize, scroll and size changes.
  useLayoutEffect(() => {
    const target = view.target;
    if (target && !inView(boxOf(target), viewport())) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    let frame = 0;
    const measure = () => {
      frame = 0;
      const size = viewport();
      const hole = target?.isConnected ? holeFor(boxOf(target), size) : null;
      const own = bubble.current?.getBoundingClientRect();
      const place = placeBubble(hole, { width: own?.width ?? 360, height: own?.height ?? 180 }, size, undefined, isMobile.value || size.width < SHEET_BELOW);
      setLayout({ hole, place, view: size });
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const resize = new ResizeObserver(queue);
    if (target) resize.observe(target);
    if (bubble.current) resize.observe(bubble.current);
    window.addEventListener('resize', queue);
    document.addEventListener('scroll', queue, true);
    document.addEventListener('transitionend', queue, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('resize', queue);
      document.removeEventListener('scroll', queue, true);
      document.removeEventListener('transitionend', queue, true);
    };
  }, [view.target, view.step.id]);

  // The focus goes into the bubble on every step (Next, or Got it).
  useEffect(() => {
    if (busy) return;
    bubble.current?.querySelector<HTMLButtonElement>('.spotlight-next')?.focus({ preventScroll: true });
  }, [view.step.id, busy]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const onButton = (event.target as HTMLElement | null)?.closest('button') !== null;
    if (event.key === 'ArrowRight' || (event.key === 'Enter' && !onButton)) { event.preventDefault(); if (!busy) tourNext(); }
    else if (event.key === 'ArrowLeft' && tour) { event.preventDefault(); if (!busy && view.canBack) tourBack(); }
  };

  const hole = layout?.hole ?? null;
  const size = layout?.view ?? viewport();
  const place = layout?.place;
  const progress = { position: view.position, total: view.total };
  const titleId = 'spotlight-title';
  const textId = 'spotlight-text';
  const radius = 10;
  return (
    <dialog
      ref={dialog} class={`spotlight ${tour ? 'spotlight-tour' : 'spotlight-hint'}`} aria-labelledby={titleId} aria-describedby={textId}
      data-step={view.step.id} data-busy={busy || undefined}
      onCancel={(event) => { event.preventDefault(); tourSkip(); }}
      onClose={(event) => { if (spot.value && event.currentTarget.isConnected) tourSkip(); }} // closed by the browser itself (a repeated Esc): Skip, never a stuck tour
      onKeyDown={onKeyDown}
    >
      <svg class="spotlight-dim" width={size.width} height={size.height} aria-hidden="true">
        <defs>
          <mask id="spotlight-mask">
            <rect x="0" y="0" width={size.width} height={size.height} fill="white" />
            {hole && !busy && <rect class="spotlight-cut" x={hole.x} y={hole.y} width={hole.width} height={hole.height} rx={radius} ry={radius} fill="black" />}
          </mask>
        </defs>
        <rect class="spotlight-shade" x="0" y="0" width={size.width} height={size.height} mask="url(#spotlight-mask)" />
      </svg>
      {hole && !busy && <div class="spotlight-ring" aria-hidden="true" style={{ left: `${hole.x}px`, top: `${hole.y}px`, width: `${hole.width}px`, height: `${hole.height}px` }} />}
      <div
        ref={bubble} class={`spotlight-bubble${place?.side === 'sheet' ? ' sheet' : place?.side === 'sheet-top' ? ' sheet top' : ''}`} data-side={place?.side}
        style={!place ? { visibility: 'hidden' } : place.side.startsWith('sheet') ? undefined : { left: `${place.x}px`, top: `${place.y}px` }}
        hidden={busy}
      >
        <div class="spotlight-head">
          {tour ? <span class="spotlight-progress tabular" aria-label={progressLabel(progress)}>{progressText(progress)}</span> : <span class="spotlight-progress">Tip</span>}
          {tour && <button type="button" class="text-button spotlight-skip" onClick={tourSkip}>Skip</button>}
        </div>
        <h2 class="spotlight-title" id={titleId}>{view.step.title}</h2>
        <p class="spotlight-text" id={textId}>{view.step.text}</p>
        <div class="spotlight-actions">
          {tour && view.step.extra && <Button variant="ghost" class="spotlight-extra" onClick={() => tourExtra(view.step.extra!.action)}>{view.step.extra.label}</Button>}
          {!tour && <Button variant="ghost" class="spotlight-extra" onClick={hintToTour}>Show the tour</Button>}
          <span class="spotlight-spacer" />
          {tour && <Button variant="secondary" class="spotlight-back" disabled={!view.canBack} onClick={tourBack}>Back</Button>}
          <Button variant="primary" class="spotlight-next" onClick={tourNext}>{!tour ? 'Got it' : view.last ? 'Done' : 'Next'}</Button>
        </div>
        <p class="sr-only" aria-live="polite">{tour ? `${progressLabel(progress)}: ` : ''}{view.step.title}. {view.step.text}</p>
      </div>
    </dialog>
  );
}
