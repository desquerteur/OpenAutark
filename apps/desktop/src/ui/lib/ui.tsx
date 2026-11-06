// Small shared UI primitives. Other areas import everything from here:
//   Button, IconButton, Chip, Spinner, Ring, EmptyState + re-exports of
//   Avatar*, Popover, Menu, Select (popover listbox), Dialog (+ DialogActions), confirm, askText, Icon.
// Header rows are lib/header.tsx (B-044: one header for every zone).
// Owns: look and accessibility of the primitives. Never: data access or app logic.

import type { ComponentChildren, JSX } from 'preact';
import { Icon } from './icons.tsx';
import type { IconName } from './icons.tsx';

export { Icon } from './icons.tsx';
export type { IconName } from './icons.tsx';
export { Avatar, AgentAvatar, HumanAvatar, agentLooks, paletteIndex } from './avatar.tsx';
export { Popover, Menu } from './popover.tsx';
export type { MenuItem, MenuSection, Placement } from './popover.tsx';
export { Select } from './select.tsx';
export type { SelectOption, SelectProps } from './select.tsx';
export { Dialog, DialogActions, askText, confirm } from './dialog.tsx';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * `busy` keeps the button's box (B-044 §2): icon and label turn transparent under a spinner centred
 * over them (base.css), so a working button never changes its width or moves a neighbour.
 */
export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: IconName; busy?: boolean }) {
  const { variant = 'secondary', icon, busy, class: className, children, ...rest } = props;
  return (
    <button type="button" {...rest} class={`button ${variant}${className ? ` ${className}` : ''}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
      {busy && <span class="button-spin"><Spinner size={14} /></span>}
    </button>
  );
}

export function IconButton(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string; size?: 'small' | 'normal'; pressed?: boolean; iconSize?: number }) {
  const { icon, label, size = 'normal', pressed, iconSize, class: className, ...rest } = props;
  return (
    <button
      type="button"
      {...rest}
      class={`icon-button${size === 'small' ? ' small' : ''}${pressed ? ' selected' : ''}${className ? ` ${className}` : ''}`}
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={pressed === undefined ? undefined : pressed}
    >
      <Icon name={icon} size={iconSize ?? (size === 'small' ? 16 : 20)} />
    </button>
  );
}

/** Small rounded pill used for model/permission/tasks chips and attachment chips. */
export function Chip(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & { icon?: IconName; tone?: 'default' | 'warn' | 'accent'; caret?: boolean }) {
  const { icon, tone = 'default', caret, class: className, children, ...rest } = props;
  return (
    <button type="button" {...rest} class={`chip tone-${tone}${className ? ` ${className}` : ''}`}>
      {icon && <Icon name={icon} size={15} />}
      <span class="chip-label">{children}</span>
      {caret && <Icon name="caret-down" size={12} class="chip-caret" />}
    </button>
  );
}

export function Spinner(props: { size?: number; label?: string }) {
  const size = props.size ?? 16;
  return <span class="spinner" style={{ width: `${size}px`, height: `${size}px` }} role="status" aria-label={props.label ?? 'Loading'} />;
}

/** Value-bound progress ring (0..100) – used by the update control and task progress. */
export function Ring(props: { value: number; size?: number; stroke?: number; class?: string; children?: ComponentChildren }) {
  const size = props.size ?? 36;
  const stroke = props.stroke ?? 3;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const value = Math.max(0, Math.min(100, props.value));
  return (
    <span class={`ring${props.class ? ` ${props.class}` : ''}`} style={{ width: `${size}px`, height: `${size}px` }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke} class="ring-track" />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke-width={stroke} class="ring-value"
          stroke-dasharray={c} stroke-dashoffset={c * (1 - value / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      {props.children && <span class="ring-content">{props.children}</span>}
    </span>
  );
}

/** One short line for empty states. */
export function EmptyState(props: { children: ComponentChildren }) {
  return <p class="empty-state">{props.children}</p>;
}
