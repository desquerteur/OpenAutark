// Select: a small popover listbox in the Codex style – a button with the current value and a
// caret, a quiet list with a check mark at the chosen option. Keyboard per the APG
// select-only combobox (arrows, Home/End, PageUp/PageDown, Enter/Space, Escape, Tab,
// type-ahead); closes on outside press, scroll and resize; opens above when there is no room
// below; works with touch. `native` keeps the browser's <select> for callers that need it.
// Owns: look and behaviour of single-value selects. Never: business logic, and never puts its
// list outside an open modal <dialog> (everything outside one is inert; inside, the list is shown in
// the top layer, lib/top-layer.ts, so the dialog's scrollbar never takes its clicks).

import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.tsx';
import { isTypeAheadKey, listKey, placeList, typeAhead, TypeAheadBuffer } from './listbox.ts';
import type { ListState } from './listbox.ts';
import { showInTopLayer } from './top-layer.ts';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  /** One quiet line under the label (list only). */
  hint?: string;
}

export interface SelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<SelectOption<T>>;
  onChange: (value: T) => void;
  /** Accessible name (the visible label usually sits next to it). */
  label: string;
  disabled?: boolean;
  class?: string;
  id?: string;
  /** Shown when the value is not among the options. */
  placeholder?: string;
  /** Render the browser's own <select> instead (only where a caller really needs it). */
  native?: boolean;
}

const CLOSED: ListState = { open: false, active: -1 };

export function Select<T extends string>(props: SelectProps<T>) {
  return props.native ? <NativeSelect {...props} /> : <ListSelect {...props} />;
}

function NativeSelect<T extends string>(props: SelectProps<T>) {
  return (
    <select id={props.id} class={props.class ?? 'select'} aria-label={props.label} value={props.value} disabled={props.disabled}
      onChange={(event) => props.onChange((event.currentTarget as HTMLSelectElement).value as T)}>
      {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

/** Where the list is mounted: inside the open modal dialog that holds the button, else <body>. */
function portalRoot(anchor: HTMLElement | null): HTMLElement {
  return anchor?.closest<HTMLElement>('dialog[open]') ?? document.body;
}

function ListSelect<T extends string>(props: SelectProps<T>) {
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const typed = useRef(new TypeAheadBuffer());
  const [state, setState] = useState<ListState>(CLOSED);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const { options } = props;
  const selected = options.findIndex((option) => option.value === props.value);
  const open = state.open && !props.disabled && options.length > 0;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const close = (refocus: boolean) => {
    setState(CLOSED);
    if (refocus) button.current?.focus({ preventScroll: true }); // B-044 §2: a pick never scrolls the dialog or page
  };
  const choose = (index: number, refocus = true) => {
    close(refocus);
    const option = options[index];
    if (option && option.value !== props.value) props.onChange(option.value);
  };

  // Inside a dialog: the top layer, before it is measured (lib/top-layer.ts).
  useLayoutEffect(() => (open ? showInTopLayer(list.current) : undefined), [open]);

  // Place the list next to the button (measured once per opening, before paint).
  useLayoutEffect(() => {
    const el = list.current;
    const anchor = button.current;
    if (!open || !el || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    el.style.minWidth = `${Math.round(rect.width)}px`;
    el.style.maxHeight = 'none';
    // offsetHeight includes the border: max-height applies to the border box, so measuring
    // scrollHeight (content only) left the list 2px short and showed a scrollbar.
    const place = placeList(rect, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight });
    el.style.left = `${place.left}px`;
    el.style.top = `${place.top}px`;
    el.style.maxHeight = `${place.maxHeight}px`;
    el.dataset.placement = place.above ? 'top' : 'bottom';
  }, [open]);

  // Keep the active option inside the list's scroll area.
  useLayoutEffect(() => {
    const el = list.current;
    const item = open && state.active >= 0 ? el?.children[state.active] as HTMLElement | undefined : undefined;
    if (!el || !item) return;
    if (item.offsetTop < el.scrollTop) el.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = item.offsetTop + item.offsetHeight - el.clientHeight;
  }, [open, state.active]);

  // Outside press, page scroll, resize and window blur close the list.
  useEffect(() => {
    if (!open) return;
    const inside = (target: EventTarget | null) => target instanceof Node && Boolean(list.current?.contains(target) || button.current?.contains(target));
    const onPointer = (event: PointerEvent) => { if (!inside(event.target)) close(false); };
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && list.current?.contains(event.target))) close(false); };
    const onLeave = () => close(false);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (props.disabled || options.length === 0) return;
    if (isTypeAheadKey(event)) {
      const query = typed.current.push(event.key, Date.now());
      const index = typeAhead(options.map((option) => option.label), query, open ? state.active : selected);
      if (index >= 0) setState({ open: true, active: index });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const result = listKey(open ? state : CLOSED, event, options.length, selected);
    if (result.handled) {
      // Also keeps Escape from closing a surrounding dialog while only the list should close.
      event.preventDefault();
      event.stopPropagation();
    }
    if (result.commit) choose(result.state.active, event.key !== 'Tab');
    else if (result.handled) setState(result.state);
  };

  // Enter/Space arrive as a click with detail 0 (keyboard); a pointer click toggles.
  const onClick = (event: MouseEvent) => {
    if (props.disabled || options.length === 0) return;
    if (!open) setState({ open: true, active: selected >= 0 ? selected : 0 });
    else if (event.detail === 0 && state.active >= 0) choose(state.active);
    else close(true);
  };

  const current = selected >= 0 ? options[selected] : undefined;
  let popup: ComponentChildren = null;
  if (open) {
    popup = createPortal(
      <div ref={list} id={listId} role="listbox" aria-label={props.label} class="select-list"
        // Pressing an option must not move focus off the button (aria-activedescendant model).
        onMouseDown={(event) => event.preventDefault()}>
        {options.map((option, index) => (
          <div
            key={option.value}
            id={optionId(index)}
            role="option"
            aria-selected={index === selected}
            class={`select-option${index === state.active ? ' active' : ''}${index === selected ? ' selected' : ''}`}
            onPointerMove={() => { if (state.active !== index) setState({ open: true, active: index }); }}
            onClick={() => choose(index)}
          >
            <span class="select-option-text">
              <span class="select-option-label">{option.label}</span>
              {option.hint && <small>{option.hint}</small>}
            </span>
            {index === selected && <Icon name="check" size={16} class="select-check" />}
          </div>
        ))}
      </div>,
      portalRoot(button.current),
    );
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        id={props.id}
        role="combobox"
        class={`select-button${props.class ? ` ${props.class}` : ''}`}
        aria-label={props.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && state.active >= 0 ? optionId(state.active) : undefined}
        disabled={props.disabled}
        onKeyDown={onKeyDown}
        // B-044 §2: a press focuses without scrolling – a select half under a dialog's footer never moves the form
        onMouseDown={(event) => { if (props.disabled || event.button !== 0) return; event.preventDefault(); button.current?.focus({ preventScroll: true }); }}
        onClick={onClick}
      >
        <span class={`select-value${current ? '' : ' is-empty'}`}>{current?.label ?? props.placeholder ?? 'Choose'}</span>
        <Icon name="caret-down" size={12} class="select-caret" />
      </button>
      {popup}
    </>
  );
}
