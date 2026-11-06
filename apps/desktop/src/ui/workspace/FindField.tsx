// Find in page (Ctrl+F, like Chrome) in the header's address slot – the same box, so nothing moves:
// the text, the shown match and the count ("3/12", a reserved cell) and Close. Typing searches at
// once (main: findInPage), Enter goes to the next match, Shift+Enter to the previous one, Escape or
// Close ends it and gives the keyboard back to the page. The last text stays for the next Ctrl+F.
// Owns: the field. Never: reads the page (main counts the matches).

import { useEffect, useRef, useState } from 'preact/hooks';
import type { WorkspaceBrowserPage } from '../../shared/api/workspace-browser.ts';
import { IconButton } from '../lib/ui.tsx';
import { closeFind, command, findOpen } from './pages.ts';

let lastText = '';

export function FindField(props: { id: string; page: WorkspaceBrowserPage | undefined }) {
  const { id } = props;
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(lastText);
  const ask = findOpen.value?.ask ?? 0;
  const find = (value: string, next = false, forward = true) => void command({ action: 'find', id, text: value, next, forward });
  useEffect(() => {
    if (lastText) find(lastText);
    return () => void command({ action: 'find-stop', id });
  }, [id]);
  useEffect(() => { field.current?.focus({ preventScroll: true }); field.current?.select(); }, [ask]);
  const close = () => { closeFind(); void command({ action: 'focus', id }); };
  const count = props.page?.find;
  return (
    <form class="browser-address-form browser-find" role="search" onSubmit={(event) => event.preventDefault()}>
      <input ref={field} class="browser-address browser-find-input" type="text" aria-label="Find in page" placeholder="Find in page" spellcheck={false} autocomplete="off" value={text}
        onInput={(event) => { const value = event.currentTarget.value; setText(value); lastText = value; find(value); }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') { event.preventDefault(); if (text) find(text, true, !event.shiftKey); }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        }} />
      <span class="browser-find-count tabular" aria-live="polite">{text && count ? `${count.active}/${count.matches}` : ''}</span>
      <IconButton icon="x" label="Close find" size="small" onClick={close} />
    </form>
  );
}
