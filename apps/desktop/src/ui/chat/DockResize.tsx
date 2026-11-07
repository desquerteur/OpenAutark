// AF-010: the grip on the inner edge of a chat's docked tabs (chat/ChatArea.tsx) and on the edges of their floating
// window: pointer capture, a live value while dragging, one write when let go, Escape cancels, arrow keys step 8 px
// (Shift 32), Home/End go to the ends, a double-click goes back to the default. `sign` turns the pointer's way into
// growth: a grip on the dock's left edge grows it when dragged left (-1).
// Owns: the drag on one grip. Never: stores anything itself (onLive/onSave) or decides the limits.

import { useEffect, useRef } from 'preact/hooks';
import { toastError } from '../lib/toasts.ts';

interface Props {
  label: string;
  class: string;
  axis: 'x' | 'y';
  sign: 1 | -1;
  /** The size now (aria and the keyboard's start). */
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  /** The size the drag starts from (measured, so a clamped dock starts where it is drawn). */
  measure(): number;
  onLive(value: number | null): void;
  onSave(value: number): Promise<unknown>;
}

export function DockResize(props: Props) {
  const start = useRef<{ at: number; size: number } | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const clamp = (value: number) => Math.round(Math.max(latest.current.min, Math.min(latest.current.max, value)));
  const cursor = props.axis === 'x' ? 'col-resize' : 'row-resize';
  const end = () => { start.current = null; document.documentElement.classList.remove('dock-resizing', 'dock-resizing-y'); };
  useEffect(() => () => end(), []);
  const point = (event: PointerEvent) => (props.axis === 'x' ? event.clientX : event.clientY);
  const save = (value: number) => { void latest.current.onSave(clamp(value)).catch((error) => toastError(error)); };
  const finish = (event: PointerEvent, cancel = false) => {
    const begin = start.current;
    if (!begin) return;
    end();
    if (cancel) { latest.current.onLive(null); return; }
    save(begin.size + (point(event) - begin.at) * latest.current.sign);
  };
  return (
    <div class={`dock-resize ${props.class}`} role="separator" aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'} aria-label={props.label}
      aria-valuemin={props.min} aria-valuemax={props.max} aria-valuenow={props.value} tabIndex={0} style={{ cursor }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation(); // never the dock's own drag
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        start.current = { at: point(event), size: props.measure() };
        document.documentElement.classList.add(props.axis === 'x' ? 'dock-resizing' : 'dock-resizing-y');
      }}
      onPointerMove={(event) => { const begin = start.current; if (begin) props.onLive(clamp(begin.size + (point(event) - begin.at) * props.sign)); }}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={() => { if (start.current) { end(); latest.current.onLive(null); } }}
      onDblClick={() => save(props.defaultValue)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && start.current) { event.preventDefault(); end(); props.onLive(null); return; }
        const step = (event.shiftKey ? 32 : 8) * props.sign;
        const back = props.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
        const forth = props.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
        const next = event.key === back ? props.value - step : event.key === forth ? props.value + step
          : event.key === 'Home' ? props.min : event.key === 'End' ? props.max : null;
        if (next !== null) { event.preventDefault(); save(next); }
      }} />
  );
}
