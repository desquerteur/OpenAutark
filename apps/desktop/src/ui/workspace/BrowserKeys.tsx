// The phone's on-screen keyboard for a taken-over agent browser (X02): "Type" in BrowserLive.tsx
// focuses this visually hidden field. It is a password field – no composition, no suggestions,
// the keyboard learns nothing – at 16 px (iOS does not zoom into it). It holds one zero-width
// sentinel: what is typed or inserted goes to the page as text, deleting the sentinel as
// Backspace, Enter as Enter, Tab and arrow keys of a hardware keyboard as keys (browser-touch.ts
// keyProxy); after every event it holds the sentinel again, so nothing typed stays or shows.
// Esc leaves the field. Owns: the field. Never: keeps, renders or logs what is typed.

import type { Ref } from 'preact';
import { useMemo, useRef } from 'preact/hooks';
import type { BrowserInput } from '../../shared/model/browser.ts';
import { KEY_SENTINEL, keyProxy } from './browser-touch.ts';

/** Puts `value` back and the caret after it (so the next Backspace deletes the sentinel). */
function reset(field: HTMLInputElement, value: string): void {
  field.value = value;
  try { field.setSelectionRange(value.length, value.length); } catch { /* not focused */ }
}

export function BrowserKeys(props: { push: (input: BrowserInput) => void; field: Ref<HTMLInputElement>; label: string }) {
  const latest = useRef(props.push);
  latest.current = props.push;
  const proxy = useMemo(() => keyProxy((input) => latest.current(input)), []);
  return (
    <input ref={props.field} class="browser-keys" type="password" autocomplete="off" autocapitalize="none" spellcheck={false} enterKeyHint="go"
      aria-label={props.label} tabIndex={-1} defaultValue={KEY_SENTINEL}
      onFocus={(event) => reset(event.currentTarget, KEY_SENTINEL)}
      onInput={(event) => reset(event.currentTarget, proxy.input(event.currentTarget.value))}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { event.currentTarget.blur(); return; }
        if (proxy.key(event, 'down')) { event.preventDefault(); event.stopPropagation(); }
      }}
      onKeyUp={(event) => { if (proxy.key(event, 'up')) { event.preventDefault(); event.stopPropagation(); } }} />
  );
}
