// Settings building blocks: groups, functional rows (label left, control right; `menu` is the row's right-click
// menu, lib/context-menu.tsx), switch, select, segmented choice, a row action that keeps its box while it runs and
// a small async-data hook. A hint that arrives later reserves its line (`reserve`), so nothing moves.
// Owns: the visual grammar of the settings page (also reused by the agent view). Never: talks RPC itself.

import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { useContextMenu } from '../lib/context-menu.tsx';
import type { MenuSection } from '../lib/popover.tsx';
import { errorText } from '../lib/rpc.ts';
import { Select as ListSelect } from '../lib/select.tsx';
import { toastError } from '../lib/toasts.ts';
import { Button } from '../lib/ui.tsx';

/** Clears an optional settings field: the runtime merge treats `null` as "remove key". */
export const CLEAR = null as unknown as undefined;

export function Group(props: { title?: string; id?: string; children: ComponentChildren; actions?: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <section class="set-group" id={props.id}>
      {(props.title || props.actions) && (
        <header class="set-group-head">
          {props.title && <h3>{props.title}</h3>}
          {props.actions && <div class="set-group-actions">{props.actions}</div>}
        </header>
      )}
      {props.hint && <p class="set-group-hint">{props.hint}</p>}
      <div class="set-rows">{props.children}</div>
    </section>
  );
}

const NO_MENU = (): MenuSection[] => [];

/**
 * `reserve`: the hint line is always there (one line, clipped, the full text as tooltip; `2`: two lines).
 * `disabled`: the control is off for now (the label turns quiet). `menu`: the right-click menu, built when it opens.
 */
export function Row(props: { label: ComponentChildren; hint?: ComponentChildren; children?: ComponentChildren; stack?: boolean; reserve?: boolean | 2; disabled?: boolean; class?: string; menu?: () => MenuSection[] }) {
  const hint = props.hint === false ? undefined : props.hint;
  const menu = useContextMenu(props.menu ?? NO_MENU);
  return (
    <div class={`set-row${props.stack ? ' stack' : ''}${props.reserve ? ' reserve' : ''}${props.disabled ? ' disabled' : ''}${props.class ? ` ${props.class}` : ''}`} {...(props.menu ? menu : {})}>
      <div class="set-row-text">
        <div class="set-row-label">{props.label}</div>
        {props.reserve
          ? <div class={`set-row-hint reserved${props.reserve === 2 ? ' two' : ''}`} title={typeof hint === 'string' ? hint : undefined}>{hint ?? ''}</div>
          : hint && <div class="set-row-hint">{hint}</div>}
      </div>
      {props.children !== undefined && <div class="set-row-control">{props.children}</div>}
    </div>
  );
}

/** A small row action with a fixed box (lib/ui.tsx Button `busy`: the spinner sits over the label, the width stays). */
export function ActionButton(props: { label: string; onClick: () => void; busy?: boolean; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost'; class?: string }) {
  return (
    <Button variant={props.variant ?? 'secondary'} class={`small${props.class ? ` ${props.class}` : ''}`} busy={props.busy} disabled={props.disabled} onClick={props.onClick}>
      {props.label}
    </Button>
  );
}

export function Toggle(props: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      class={`switch${props.checked ? ' on' : ''}`}
      aria-checked={props.checked}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="switch-knob" />
    </button>
  );
}

/** `hint`: one quiet line under the option in the open list (the button shows the label only). */
export interface Option<T extends string> { value: T; label: string; hint?: string }

/** Settings select: the shared popover listbox (lib/select.tsx) in the settings look. */
export function Select<T extends string>(props: { value: T; options: Array<Option<T>>; onChange: (value: T) => void; label: string; disabled?: boolean; native?: boolean }) {
  return <ListSelect class="set-select" {...props} />;
}

/** A text field that commits on blur or Enter (the value stays where it is until then). */
export function TextField(props: {
  value: string; onCommit: (value: string) => void; label: string; placeholder?: string;
  type?: 'text' | 'url' | 'time' | 'email'; maxLength?: number; wide?: boolean; disabled?: boolean;
}) {
  const [draft, setDraft] = useState(props.value);
  useEffect(() => setDraft(props.value), [props.value]);
  const commit = () => { if (draft !== props.value) props.onCommit(draft); };
  return (
    <input class={`set-input${props.wide ? ' wide' : ''}`} type={props.type ?? 'text'} aria-label={props.label} placeholder={props.placeholder}
      maxLength={props.maxLength} disabled={props.disabled} value={draft}
      onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur(); }} />
  );
}

/** A number field that commits on blur or Enter; anything that is no number below `min` goes back to the stored value. */
export function NumberField(props: { value: number; onCommit: (value: number) => void; label: string; min?: number; suffix?: string; disabled?: boolean }) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  const commit = () => {
    const next = Number(draft.trim());
    if (!draft.trim() || !Number.isFinite(next) || (props.min !== undefined && next < props.min)) { setDraft(String(props.value)); return; }
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <span class="set-number">
      <input class="set-input narrow" inputMode="decimal" aria-label={props.label} value={draft} disabled={props.disabled}
        onInput={(event) => setDraft((event.currentTarget as HTMLInputElement).value)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur(); }} />
      {props.suffix && <span class="set-suffix">{props.suffix}</span>}
    </span>
  );
}

export function Segmented<T extends string>(props: { value: T; options: Array<Option<T>>; onChange: (value: T) => void; label: string }) {
  return (
    <div class="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={option.value === props.value}
          class={option.value === props.value ? 'selected' : ''} onClick={() => props.onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Small state line: "Unavailable", errors, loading – never fake values. */
export function Note(props: { children: ComponentChildren; tone?: 'muted' | 'error' | 'ok' }) {
  return <span class={`set-note ${props.tone ?? 'muted'}`}>{props.children}</span>;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  set: (value: T) => void;
}

/** Loads data once (and on reload). Keeps the old value while reloading. */
export function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(true);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await load();
      if (alive.current) { setData(value); setError(null); }
    } catch (err) {
      if (alive.current) setError(errorText(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, deps);
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);
  return { data, error, loading, reload, set: setData };
}

/** Runs an action and shows an error toast on failure. Returns the result or undefined. */
export async function act<T>(run: () => Promise<T>, failTitle = 'Action failed'): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    toastError(new Error(errorText(error)), failTitle);
    return undefined;
  }
}

/** Busy flag around an async action (disables buttons while running). */
export function useBusy(): [boolean, <T>(run: () => Promise<T>) => Promise<T | undefined>] {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>) => {
    setBusy(true);
    try { return await act(fn); } finally { setBusy(false); }
  }, []);
  return [busy, run];
}
