// The calm shell around every ask widget (chat, "For you", Home, PWA): optional title and a
// collapsed "why", the widget, and – once answered – a one-line receipt instead of the widget: in the
// chat what the block asked (the person's own line below carries what they picked, B-076), in lists the answer.
// Owns: submit flow (busy, error toast, receipt), the answered state per block, Snooze only
// where a to-do stands behind the widget (blocks/snooze.ts).
// Never: more than one subtle surface.

import { useState } from 'preact/hooks';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { Icon } from '../lib/ui.tsx';
import { toastError } from '../lib/toasts.ts';
import { pushToast } from '../lib/toasts.ts';
import { time } from '../lib/format.ts';
import { askedText, noteAnswered, receiptFor, submitAnswer, submitSnooze, targetKey, useAnswered } from './ask.ts';
import type { AskTarget } from './ask.ts';
import { ASK_WIDGETS } from './registry.tsx';
import { clearDrafts } from './host.ts';
import { canSnooze } from './snooze.ts';

export interface AskBlockProps {
  block: UiBlock;
  target: AskTarget;
  /** Hide the title row (the To-do list already shows the title in its row). */
  bare?: boolean;
  onAnswered?: (summary: string) => void;
}

export function AskBlock(props: AskBlockProps) {
  const { block, target } = props;
  const receipt = useAnswered(target);
  const [busy, setBusy] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const key = targetKey(target);
  const Widget = ASK_WIDGETS[block.type];

  if (receipt) {
    // In the chat the person's own line below says what they picked: the block keeps what it asked (B-076).
    const shown = props.bare ? receipt : askedText(block) ?? receipt;
    return (
      <div class="ask-receipt" role="status" title={shown === receipt ? undefined : receipt}>
        <Icon name="check-circle" size={16} />
        <span>{shown}</span>
      </div>
    );
  }
  if (!Widget) return null;

  const submit = async (answer: unknown) => {
    setBusy(true);
    try {
      await submitAnswer(target, answer);
      const summary = receiptFor(block, answer);
      clearDrafts(key); // the shell key and every widget sub-key (values, files, note …)
      // A repeating timer comes back at its next ring: no lasting receipt in its place.
      if (!(block.type === 'timer' && block.repeat)) noteAnswered(target, summary);
      props.onAnswered?.(summary);
      return true;
    } catch (error) {
      toastError(error, "Couldn't send the answer");
      return false;
    } finally {
      setBusy(false);
    }
  };

  // F03: the to-do waits and rings again – no receipt, the agent is not woken.
  const snooze = async (until: number) => {
    setBusy(true);
    try {
      await submitSnooze(target, until); // X01: a linked PC's to-do snoozes there
      pushToast({ title: `Snoozed until ${time(until)}` }, 3000);
      return true;
    } catch (error) {
      toastError(error, "Couldn't snooze");
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section class={`ask-block type-${block.type}`} aria-label={block.title ?? block.type}>
      {!props.bare && (block.title || block.why) && (
        <header class="ask-head">
          {block.title && <span class="ask-title">{block.title}</span>}
          {block.why && (
            <button type="button" class="ask-why-toggle" aria-expanded={whyOpen} onClick={() => setWhyOpen(!whyOpen)} title="Why">
              <Icon name="info" size={14} />
            </button>
          )}
        </header>
      )}
      {whyOpen && block.why && <p class="ask-why">{block.why}</p>}
      <Widget block={block} draftKey={key} submit={submit} busy={busy} snooze={canSnooze(block, target) ? snooze : undefined} />
    </section>
  );
}
