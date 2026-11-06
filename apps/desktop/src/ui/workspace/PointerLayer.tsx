// Named cursors over a live browser view (B-055 Q8; BrowserLive.tsx – a chat's browser or an agent's
// own): a DOM layer over the picture draws every other pointer on the view's surface (pointers.changed:
// agents' cursors with their names, other people's) where it points on the page – mapped from the
// page's CSS px onto the letterboxed picture (pointer-overlay.ts) – and an agent's move travels along
// the path its mouse took (the shared motion steps), with one animation frame loop only while a move
// is under way; a pointer older than POINTER_TTL_MS goes by itself (one timer for the next to expire).
// A view that opens reads the surface's pointers once (pointers.list), then follows the events.
// The person's own pointer over the picture is reported to the runtime (pointers.point, about 8 a
// second at most, in page CSS px; a press as a click) so agents read where the person points. Only
// for a browser on this PC (a linked PC has its own runtime), never from a phone (device scope: no pointers). The layer
// takes no input itself.
// Owns: that layer and the reporting. Never: forwards input to the page (BrowserSurface.tsx does,
// while taken over) or keeps pointers anywhere but in this view.

import type { RefObject } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { BrowserFrame } from '../../shared/model/browser.ts';
import { HUMAN_ID } from '../../shared/ids.ts';
import { POINTER_TTL_MS, type PointerAction, type PointerPoint } from '../../shared/model/pointers.ts';
import { paletteIndex } from '../lib/avatar.tsx';
import { rpc } from '../lib/rpc.ts';
import { can, isOwner } from '../lib/session.ts';
import { framePoint } from './browser-input.ts';
import { createPointerReporter, pagePointInView, pathMs, positionAt, shownPointers, viewSurface } from './pointer-overlay.ts';

const point = (params: { surface: string; x: number; y: number; action?: PointerAction }) => rpc.call('pointers.point', params);

/** This person's own pointer, never drawn back: the owner's actor id (the runtime names the owner 'human'), else the last point sent. */
const self: { id?: string; last?: { x: number; y: number } } = {};

interface Drawn { point: PointerPoint; arrived: number }

const box = (rect: DOMRect) => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

export function PointerLayer(props: { agentId: string; frame: BrowserFrame; view: RefObject<HTMLElement> }) {
  const { frame } = props;
  const surface = viewSurface(props.agentId, frame.tab);
  const [drawn, setDrawn] = useState<Drawn[]>([]);
  const [, setTick] = useState(0);
  const size = useRef(frame);
  size.current = frame;

  useEffect(() => {
    setDrawn([]);
    self.id = isOwner() ? HUMAN_ID : undefined;
    let live = true;
    const take = (points: readonly PointerPoint[]) => {
      const arrived = performance.now();
      setDrawn((before) => points.map((next) => {
        const known = before.find((entry) => entry.point.actor.id === next.actor.id);
        return known && known.point.at === next.at ? known : { point: next, arrived }; // an unchanged pointer keeps its animation
      }));
    };
    if (can('pointers.list')) rpc.call('pointers.list', { surface }).then((state) => { if (live) take(state.points); }, () => undefined); // a phone (device) neither lists nor points
    const stop = rpc.on('pointers.changed', (state) => { if (state.surface === surface) take(state.points); });
    return () => { live = false; stop(); };
  }, [surface]);

  // a move under way: one frame loop until it arrives; then one timer for the next pointer to expire
  useEffect(() => {
    const moving = () => drawn.some((entry) => performance.now() - entry.arrived < pathMs(entry.point.path));
    let frameId = 0;
    const step = () => { setTick((n) => n + 1); frameId = moving() ? requestAnimationFrame(step) : 0; };
    if (moving()) frameId = requestAnimationFrame(step);
    const next = Math.min(...drawn.map((entry) => entry.point.at + POINTER_TTL_MS));
    const expiry = Number.isFinite(next) ? setTimeout(() => setTick((n) => n + 1), Math.max(0, next - Date.now()) + 20) : undefined;
    return () => { if (frameId) cancelAnimationFrame(frameId); if (expiry) clearTimeout(expiry); };
  }, [drawn]);

  // the picture moved or resized (the pane, a zoom): place the cursors again
  useEffect(() => {
    const view = props.view.current;
    if (!view || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setTick((n) => n + 1));
    observer.observe(view);
    const picture = view.querySelector('img');
    if (picture) observer.observe(picture);
    return () => observer.disconnect();
  }, [props.view.current, frame.width, frame.height]);

  // the person's own pointer over the picture → the runtime (throttled; a press goes at once as a click)
  const reporter = useMemo(() => createPointerReporter({
    send: ({ x, y }) => { self.last = { x, y }; void point({ surface, x, y }).catch(() => undefined); },
    now: () => performance.now(), set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }), [surface]);
  useEffect(() => {
    const view = props.view.current;
    if (!view || !can('pointers.point')) return;
    const at = (event: MouseEvent) => {
      const picture = view.querySelector('img');
      if (!picture) return undefined;
      const spot = framePoint(event.clientX, event.clientY, box(picture.getBoundingClientRect()), size.current);
      return spot ? { x: spot.x, y: spot.y } : undefined;
    };
    const move = (event: MouseEvent) => { const spot = at(event); if (spot) reporter.move(spot); };
    const press = (event: MouseEvent) => {
      const spot = at(event);
      if (!spot) return;
      self.last = spot;
      void point({ surface, ...spot, action: 'click' }).catch(() => undefined);
    };
    view.addEventListener('mousemove', move);
    view.addEventListener('mousedown', press);
    return () => { view.removeEventListener('mousemove', move); view.removeEventListener('mousedown', press); reporter.stop(); };
  }, [reporter, props.view.current]);

  const view = props.view.current;
  const picture = view?.querySelector('img');
  if (!view || !picture) return null;
  const viewBox = box(view.getBoundingClientRect());
  const pictureBox = box(picture.getBoundingClientRect());
  const live = new Set(shownPointers(drawn.map((entry) => entry.point), surface, Date.now(), self));
  const now = performance.now();
  return (
    <div class="browser-pointers" role="group" aria-label="Pointers on this page">
      {drawn.filter((entry) => live.has(entry.point)).map(({ point: pointer, arrived }) => {
        const elapsed = now - arrived;
        const moving = Boolean(pointer.path?.length) && elapsed < pathMs(pointer.path);
        const spot = moving ? positionAt(pointer.path!, elapsed)! : pointer;
        const place = pagePointInView(spot.x, spot.y, frame, pictureBox, viewBox);
        if (!place) return null;
        const who = `${pointer.actor.name} (${pointer.actor.kind === 'person' ? 'person' : 'agent'})`;
        return (
          <div key={pointer.actor.id} class="browser-pointer" role="img" aria-label={`${who} points here`} data-click={!moving && pointer.action === 'click' ? '' : undefined}
            style={{ transform: `translate(${Math.round(place.left)}px, ${Math.round(place.top)}px)`, '--pointer': `var(--av-${paletteIndex(pointer.actor.id)}-fg)`, '--pointer-on': `var(--av-${paletteIndex(pointer.actor.id)}-bg)` }}>
            <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><path d="M1.5 1.5v14.2l3.9-3.7 2.6 6.3 2.6-1.1-2.6-6.2h5.4z" stroke-width="1.3" stroke-linejoin="round" /></svg>
            <span class="browser-pointer-name">{pointer.actor.name}</span>
          </div>
        );
      })}
    </div>
  );
}
