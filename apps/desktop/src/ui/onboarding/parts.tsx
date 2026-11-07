// The setup assistant's card frame (B-044 §2, nothing moves): a card with its heading, AF-002's one sentence on what the
// step is for, a body and one action row at its foot, the card's one reserved status line – always drawn (empty when
// there is nothing to say), so a note or an error that arrives later never changes the card's height. StepBar: "Step 2
// of 4" and the four step names, the current one marked (colour only).
// Owns: this markup. Never: what a card says or does.

import type { ComponentChildren } from 'preact';
import { CARDS, STEP_INFO, stepText, type Card as CardId } from './first-run-model.ts';

export function Card(props: { id: string; title: string; purpose?: string; children: ComponentChildren; actions: ComponentChildren; busy?: boolean }) {
  return (
    <section class="first-run-card" aria-labelledby={`${props.id}-title`} aria-describedby={props.purpose ? `${props.id}-purpose` : undefined} aria-busy={props.busy || undefined} data-card={props.id}>
      <h2 class="first-run-title" id={`${props.id}-title`}>{props.title}</h2>
      {props.purpose && <p class="first-run-purpose" id={`${props.id}-purpose`}>{props.purpose}</p>}
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

/** "Step 2 of 4" and the step names above the card. */
export function StepBar(props: { step: CardId }) {
  return (
    <div class="first-run-progress">
      <p class="first-run-step" aria-live="polite">{stepText(props.step)}</p>
      <ol class="first-run-steps" aria-label="Setup steps">
        {CARDS.map((card) => (
          <li key={card} class="first-run-step-name" aria-current={card === props.step ? 'step' : undefined}>{STEP_INFO[card].title}</li>
        ))}
      </ol>
    </div>
  );
}
