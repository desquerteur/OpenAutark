// One right-click menu for the whole app (owner, 31.10.2026: "mit Rechtsklicks arbeiten … generell in
// unserem System"). Any row spreads `useContextMenu(() => sections)` on its root: a right click (mouse)
// or a long press (touch) opens the shared Menu at the pointer. <ContextMenuHost/> is mounted once in
// App.tsx. Builders run when the menu opens, so they always see current state.
// A row inside a modal keeps the menu's anchor and popover inside that dialog's top layer.
// Owns: where the menu opens and the touch long-press. Never: what an item does (the caller's builder).

import { signal } from '@preact/signals';
import { addBackLayer } from './back-layers.ts';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Menu } from './popover.tsx';
import type { MenuSection } from './popover.tsx';

interface OpenMenu { x: number; y: number; sections: MenuSection[]; host?: HTMLElement | null }

const current = signal<OpenMenu | null>(null);

const LONG_PRESS_MS = 500;
const MOVE_SLOP = 10;
/** Native controls keep their own right-click (text fields, links inside messages keep copy/paste). */
const NATIVE = 'input, textarea, [contenteditable="true"], select';

/** Opens the shared menu at a point (also usable from a ⋯ button: pass its rect's bottom-left). */
export function openContextMenu(x: number, y: number, sections: MenuSection[], host?: HTMLElement | null): void {
  const filled = sections.filter((section) => section.items.length > 0);
  if (filled.length) current.value = { x, y, sections: filled, host };
}

export function closeContextMenu(): void {
  current.value = null;
}

addBackLayer({ open: () => current.peek() !== null, close: closeContextMenu }); // the phone's Back closes it first

/** Props for an element: right-click and touch long-press open `build()`'s sections. */
export function useContextMenu(build: () => MenuSection[]) {
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  const fired = useRef(false);
  const cancel = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };
  useEffect(() => cancel, []);
  const native = (event: Event) => Boolean((event.target as Element | null)?.closest?.(NATIVE));
  const host = (event: Event) => (event.target as Element | null)?.closest?.<HTMLElement>('dialog[open]');
  return {
    onContextMenu: (event: MouseEvent) => {
      if (native(event)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
      if (fired.current) return; // the long press already opened it
      openContextMenu(event.clientX, event.clientY, build(), host(event));
    },
    onPointerDown: (event: PointerEvent) => {
      fired.current = false;
      cancel();
      if (event.pointerType !== 'touch' || native(event)) return;
      const { clientX: x, clientY: y } = event;
      const container = host(event);
      press.current = { x, y, timer: setTimeout(() => { fired.current = true; press.current = null; openContextMenu(x, y, build(), container); }, LONG_PRESS_MS) };
    },
    onPointerMove: (event: PointerEvent) => {
      const at = press.current;
      if (at && Math.hypot(event.clientX - at.x, event.clientY - at.y) > MOVE_SLOP) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent) => {
      // the click that ends a long press must not also open the row
      if (!fired.current) return;
      fired.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}

/** The one menu; mounted once at the app root. */
export function ContextMenuHost() {
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const open = current.value;
  return (
    <>
      {createPortal(<div
        ref={setAnchor}
        class="context-menu-anchor"
        aria-hidden="true"
        style={{ position: 'fixed', left: `${open?.x ?? -9999}px`, top: `${open?.y ?? -9999}px`, width: '0px', height: '0px', pointerEvents: 'none' }}
      />, open?.host?.isConnected ? open.host : document.body)}
      <Menu
        key={open ? `${open.x},${open.y}` : 'closed'}
        anchor={anchor}
        open={open !== null}
        onClose={closeContextMenu}
        placement="bottom-start"
        label="Context menu"
        sections={open?.sections ?? []}
      />
    </>
  );
}
