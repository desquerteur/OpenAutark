// The first-run cards' frame (B-044 §2, nothing moves): a card with its heading, a body and one
// action row at its foot, the card's one reserved status line – always drawn (empty when there is
// nothing to say), so a note or an error that arrives later never changes the card's height.
// Owns: this markup. Never: what a card says or does.

import type { ComponentChildren } from 'preact';

export function Card(props: { id: string; title: string; children: ComponentChildren; actions: ComponentChildren; busy?: boolean }) {
  return (
    <section class="first-run-card" aria-labelledby={`${props.id}-title`} aria-busy={props.busy || undefined} data-card={props.id}>
      <h2 class="first-run-title" id={`${props.id}-title`}>{props.title}</h2>
      <div class="first-run-body">{props.children}</div>
      <div class="first-run-actions">{props.actions}</div>
    </section>
  );
}

/** One line, always there: a note, an error (tone 'error') or nothing; the full text is the tooltip. */
export function StatusLine(props: { text?: string; tone?: 'error' | 'ok' }) {
  return (
    <p class={`first-run-status${props.tone ? ` ${props.tone}` : ''}`} role="status" title={props.text || undefined}>{props.text ?? ''}</p>
  );
}
