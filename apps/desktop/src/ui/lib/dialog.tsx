// Modal dialog on the native <dialog> element (focus trap, Escape, backdrop for free) plus a
// promise-based confirm() for destructive actions and askText() for one line of text (Rename). A form dialog ends with
// DialogActions: its buttons beside one always reserved message line (an error, a test result, a
// note – left of the buttons since round 2 of the visual pass, overlays.css), so Save / Cancel never move when a
// message comes or goes (B-044 §2). Three fixed parts (visual
// pass, round 2): the title row, the content – the only part that scrolls, its scrollbar's room always
// reserved (a message or another word never narrows the fields) and its scrollbar between the title and
// the buttons, never past them – and the footer: DialogActions renders there wherever it sits in the
// form (a portal into the dialog's own footer, so a form keeps its state in one component). A hairline
// under the title and over the footer shows only while content lies under it (overlays.css). A dialog
// with the `anchored` class (a form whose content grows) opens at a fixed top instead of re-centring.
// Owns: modal chrome, the actions row with its message slot and the confirm/askText queue. Never: business logic.

import { createContext, type ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { signal } from '@preact/signals';
import { addBackLayer } from './back-layers.ts';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.tsx';

/** The open dialog's footer element DialogActions renders into (undefined: no Dialog around it). */
const FooterSlot = createContext<HTMLElement | null | undefined>(undefined);

export function Dialog(props: { open: boolean; onClose: () => void; title?: string; class?: string; children: ComponentChildren; width?: number }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [footer, setFooter] = useState<HTMLElement | null>(null);
  // Layout effect: the native dialog follows `open` right after each render. With a passive
  // effect a quick close→reopen (Ctrl+K right after a palette command) ran the stale close after
  // the reopen and shut the dialog again.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (props.open && !dialog.open) dialog.showModal();
    if (!props.open && dialog.open) dialog.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      aria-label={props.title}
      class={`dialog${props.class ? ` ${props.class}` : ''}`}
      style={props.width ? { width: `min(${props.width}px, calc(100vw - 32px))` } : undefined}
      // The close event fires asynchronously: after a quick reopen (e.g. Ctrl+K right after a palette
      // command) a stale event must not close the dialog that is open again.
      // An unmounted one (its view remounted when the window crossed the phone layout) closes nothing.
      onClose={() => { const dialog = ref.current; if (dialog && props.open && !dialog.open) props.onClose(); }}
      onClick={(event) => { if (event.target === ref.current) props.onClose(); }}
    >
      {props.open && (
        <div class="dialog-body">
          {props.title && (
            <header class="dialog-header">
              <h2>{props.title}</h2>
              <button type="button" class="icon-button small" aria-label="Close" onClick={props.onClose}><Icon name="x" size={18} /></button>
            </header>
          )}
          <FooterSlot.Provider value={footer}>
            <div class="dialog-content">{props.children}</div>
          </FooterSlot.Provider>
          <div class="dialog-footer" ref={setFooter} />
        </div>
      )}
    </dialog>
  );
}

/** A form dialog's buttons with the message slot beside them – always there (empty = blank), two lines at most
 *  (the buttons' height, overlays.css), then cut with an ellipsis (the whole text as its tooltip), so an error never
 *  pushes Save / Cancel down. Both go
 *  into the dialog's fixed footer under the scrolling content, so Save is never out of reach; outside a
 *  Dialog they render in place, in a footer of their own. A form that never passes `message` (Done, Cancel / Save
 *  only) marks its slot `unused`: a narrow phone sheet reserves the message's own lines above the buttons only for
 *  a form that can show one (mobile.css). */
export function DialogActions(props: { message?: string; tone?: 'error' | 'ok' | 'muted'; children: ComponentChildren }) {
  const slot = useContext(FooterSlot);
  const text = props.message ?? '';
  const unused = !('message' in props);
  const parts = (
    <>
      <p class={`dialog-message${text ? ` ${props.tone ?? 'error'}` : ''}${unused ? ' unused' : ''}`} role="status" title={text || undefined}>{text}</p>
      <div class="dialog-actions">{props.children}</div>
    </>
  );
  if (slot === undefined) return <div class="dialog-footer">{parts}</div>;
  return slot ? createPortal(parts, slot) : null;
}

interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel: string;
  danger?: boolean;
  /** askText: the field's label and starting value (no text field without it). */
  field?: { label: string; value: string };
  resolve: (answer: string | null) => void;
}

const pending = signal<ConfirmRequest | null>(null);

function ask(request: Omit<ConfirmRequest, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    pending.value?.resolve(null);
    pending.value = { ...request, resolve };
  });
}

// the phone's Back cancels an open confirm first (ui/pwa/back.ts)
addBackLayer({ open: () => pending.peek() !== null, close: () => { pending.peek()?.resolve(null); pending.value = null; } });

/** Asks once; resolves true when confirmed. */
export async function confirm(options: { title: string; body?: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return (await ask({ confirmLabel: 'Confirm', ...options })) !== null;
}

/** Asks for one line of text (Rename); resolves the trimmed text, or null when cancelled or left empty. */
export async function askText(options: { title: string; label: string; value?: string; confirmLabel?: string }): Promise<string | null> {
  const text = await ask({ title: options.title, confirmLabel: options.confirmLabel ?? 'Save', field: { label: options.label, value: options.value ?? '' } });
  return text?.trim() || null;
}

/** Mounted once by the shell. */
export function ConfirmHost() {
  const request = pending.value;
  const [text, setText] = useState('');
  useLayoutEffect(() => { setText(request?.field?.value ?? ''); }, [request]);
  const done = (answer: string | null) => { request?.resolve(answer); pending.value = null; };
  return (
    <Dialog open={!!request} onClose={() => done(null)} title={request?.title} width={400}>
      <form onSubmit={(event) => { event.preventDefault(); done(text); }}>
        {request?.body && <p class="dialog-text">{request.body}</p>}
        {request?.field && (
          <input class="input dialog-field" value={text} aria-label={request.field.label} maxLength={120} autoFocus
            onInput={(event) => setText((event.currentTarget as HTMLInputElement).value)} />
        )}
        <div class="dialog-actions">
          <button type="button" class="button secondary" onClick={() => done(null)}>Cancel</button>
          <button type="submit" class={`button ${request?.danger ? 'danger-fill' : 'primary'}`} disabled={!!request?.field && !text.trim()}>{request?.confirmLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}
