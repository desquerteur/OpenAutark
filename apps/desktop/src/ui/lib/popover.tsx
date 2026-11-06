// Popover and Menu primitives. A popover is portalled to <body> (inside the open modal dialog that holds
// its anchor, like lib/select.tsx – outside it a modal dialog makes it inert – and there shown in the top
// layer, lib/top-layer.ts, so the dialog's scrollbar never takes its clicks), placed next to its anchor
// element and clamped to the viewport – again whenever its content changes size (a ResizeObserver,
// so a list that fills in or grows while open stays on screen); it closes on outside click and Escape.
// Owns: placement, dismissal, menu keyboard navigation. Never: holds business logic.

import type { ComponentChildren, JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';
import { showInTopLayer } from './top-layer.ts';

export type Placement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end' | 'right-end' | 'right-start';

export interface PopoverProps {
  anchor: HTMLElement | null;
  /** Lines the popover up sideways with this element instead of the anchor (a call line's menu ends under the
   *  call cell); the anchor stays the toggle, the vertical place and where Escape returns focus. */
  align?: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  placement?: Placement;
  class?: string;
  width?: number;
  children: ComponentChildren;
  /** Keep open when the pointer moves between anchor and popover (hover cards). */
  role?: string;
  label?: string;
}

export function Popover(props: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [size, setSize] = useState(''); // the rendered size; a change places the popover again

  // Inside a dialog: the top layer, before it is measured (lib/top-layer.ts).
  useLayoutEffect(() => (props.open ? showInTopLayer(ref.current) : undefined), [props.open]);

  useLayoutEffect(() => {
    if (!props.open || !props.anchor || !ref.current) return;
    const a = props.anchor.getBoundingClientRect();
    const side = (props.align ?? props.anchor).getBoundingClientRect();
    const el = ref.current.getBoundingClientRect();
    const gap = 8;
    const placement = props.placement ?? 'bottom-start';
    let left = side.left;
    let top = a.bottom + gap;
    if (placement.startsWith('top')) top = a.top - el.height - gap;
    if (placement.endsWith('end') && !placement.startsWith('right')) left = side.right - el.width;
    if (placement.startsWith('right')) {
      left = a.right + gap;
      top = placement === 'right-end' ? a.bottom - el.height : a.top;
    }
    // Flip vertically when there is no room, then clamp into the viewport.
    if (placement.startsWith('top') && top < 8) top = a.bottom + gap;
    if (placement.startsWith('bottom') && top + el.height > innerHeight - 8 && a.top - el.height - gap > 8) top = a.top - el.height - gap;
    left = Math.max(8, Math.min(left, innerWidth - el.width - 8));
    top = Math.max(8, Math.min(top, innerHeight - el.height - 8));
    setPos({ left, top });
  }, [props.open, props.anchor, props.align, props.placement, size]);

  useEffect(() => {
    const el = ref.current;
    if (!props.open || !el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setSize(`${el.offsetWidth}x${el.offsetHeight}`));
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.open]);

  useEffect(() => {
    if (!props.open) { setPos(null); return; }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || props.anchor?.contains(target)) return;
      props.onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      // preventDefault: Escape closes only the popover, never a surrounding dialog (like lib/select.tsx).
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(); props.anchor?.focus({ preventScroll: true }); }
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [props.open, props.anchor]);

  if (!props.open) return null;
  return createPortal(
    <div
      ref={ref}
      class={`popover${props.class ? ` ${props.class}` : ''}`}
      role={(props.role ?? 'dialog') as JSX.AriaRole}
      aria-label={props.label}
      style={{ left: `${pos?.left ?? -9999}px`, top: `${pos?.top ?? -9999}px`, width: props.width ? `${props.width}px` : undefined }}
    >
      {props.children}
    </div>,
    props.anchor?.closest<HTMLElement>('dialog[open]') ?? document.body,
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string; // small grey text right/below
  description?: string; // one line under the label
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

/** Keyboard-navigable menu inside a popover. */
export function Menu(props: Omit<PopoverProps, 'children'> & { sections: MenuSection[]; header?: ComponentChildren; footer?: ComponentChildren }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const first = listRef.current?.querySelector<HTMLButtonElement>('button[role^=menuitem]:not(:disabled)');
    requestAnimationFrame(() => first?.focus({ preventScroll: true }));
  }, [props.open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('button[role^=menuitem]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <Popover {...props} role="menu" class={`menu${props.class ? ` ${props.class}` : ''}`}>
      {props.header}
      <div ref={listRef} onKeyDown={onKeyDown}>
        {props.sections.map((section, sectionIndex) => (
          <div class="menu-section" key={sectionIndex}>
            {section.title && <div class="menu-title">{section.title}</div>}
            {section.items.map((item, index) => (
              <button
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} // a row with a tick says whether it is ticked
                aria-checked={item.checked}
                class={`menu-item${item.danger ? ' danger' : ''}`}
                disabled={item.disabled}
                key={`${sectionIndex}:${index}`} // by place, not label: two rows can read the same (two companies of one name)
                onClick={() => { props.onClose(); item.onSelect(); }}
              >
                {item.icon && <Icon name={item.icon} size={18} />}
                <span class="menu-label">
                  <span>{item.label}</span>
                  {item.description && <small>{item.description}</small>}
                </span>
                {item.hint && <span class="menu-hint">{item.hint}</span>}
                {item.checked && <Icon name="check" size={16} class="menu-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
      {props.footer}
    </Popover>
  );
}
