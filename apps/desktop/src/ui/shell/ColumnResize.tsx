// Shared column divider: pointer capture, keyboard resizing, cancel and reset.
// Owns: the resize interaction and cleanup. Never: chooses or stores a preference.

import { useEffect, useRef } from 'preact/hooks';
import { toastError } from '../lib/toasts.ts';

interface Props {
  label: string; class: string; width: number; min: number; max: number; defaultWidth: number;
  direction?: 1 | -1; onLive(width: number | null): void; onSave(width: number): Promise<unknown>;
}

export function ColumnResize(props: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.round(Math.max(props.min, Math.min(props.max, value)));
  const clear = () => { start.current = null; props.onLive(null); document.documentElement.classList.remove('column-resizing'); };
  useEffect(() => () => { document.documentElement.classList.remove('column-resizing'); }, []);
  const save = (value: number) => { void props.onSave(clamp(value)).catch((error) => toastError(error)); };
  const finish = (event: PointerEvent, cancel = false) => {
    const begin = start.current;
    if (!begin) return;
    const next = clamp(begin.width + (event.clientX - begin.x) * (props.direction ?? 1));
    start.current = null;
    document.documentElement.classList.remove('column-resizing');
    if (cancel) { props.onLive(null); return; }
    void props.onSave(next).catch((error) => toastError(error)).finally(() => props.onLive(null));
  };
  return <div class={`column-resize ${props.class}`} role="separator" aria-orientation="vertical" aria-label={props.label}
    aria-valuemin={props.min} aria-valuemax={props.max} aria-valuenow={props.width} tabIndex={0}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      const handle = event.currentTarget as HTMLElement;
      handle.setPointerCapture(event.pointerId);
      const column = handle.closest('.global-pane') ?? handle.previousElementSibling;
      start.current = { x: event.clientX, width: column?.getBoundingClientRect().width ?? props.width };
      document.documentElement.classList.add('column-resizing');
    }}
    onPointerMove={(event) => { if (start.current) props.onLive(clamp(start.current.width + (event.clientX - start.current.x) * (props.direction ?? 1))); }}
    onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
    onLostPointerCapture={() => { if (start.current) clear(); }} onDblClick={() => save(props.defaultWidth)}
    onKeyDown={(event) => {
      if (event.key === 'Escape' && start.current) { event.preventDefault(); clear(); return; }
      const step = (event.shiftKey ? 32 : 8) * (props.direction ?? 1);
      const next = event.key === 'ArrowLeft' ? props.width - step : event.key === 'ArrowRight' ? props.width + step
        : event.key === 'Home' ? props.min : event.key === 'End' ? props.max : null;
      if (next !== null) { event.preventDefault(); save(next); }
    }} />;
}
