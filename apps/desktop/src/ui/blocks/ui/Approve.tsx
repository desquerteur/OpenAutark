// `approve` ask widget (B-078: kept for older messages and the host's own access to-dos; agents ask a yes/no
// with a choice): a plain question – what, how much, how risky – with Yes / No and an optional note. Its answer
// {approved, note?} reaches the agent as the person's line "Yes" or "No"; nothing is binding or remembered.
// Owns: the card. Never: acts on the answer itself.

import { useState } from 'preact/hooks';
import { Button } from '../../lib/ui.tsx';
import { money } from '../../lib/format.ts';
import { Inline, Markdown } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { s } from './util.ts';

export function Approve(props: AskWidgetProps) {
  const { block } = props;
  const amount = block.amount as { value: number; currency: string } | undefined;
  const risk = s(block.risk);
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const decide = (approved: boolean) => void props.submit(note.trim() ? { approved, note: note.trim() } : { approved });
  return (
    <div class="w-approve">
      <div class="w-approve-main">
        <div class="w-approve-text">
          <div class="w-question"><Inline text={s(block.action)} /></div>
          {(risk === 'medium' || risk === 'high') && <span class={`w-risk risk-${risk}`}>{risk === 'high' ? 'High risk' : 'Medium risk'}</span>}
        </div>
        {amount && <div class="w-amount tabular">{money(amount.value, amount.currency)}</div>}
      </div>
      {block.details !== undefined && <Markdown text={s(block.details)} class="w-details" />}
      {noteOpen
        ? <input class="input w-note" value={note} placeholder="Note" aria-label="Note" onInput={(event) => setNote((event.target as HTMLInputElement).value)} />
        : <button type="button" class="text-button" onClick={() => setNoteOpen(true)}>Add note</button>}
      <div class="w-actions">
        <Button variant="primary" busy={props.busy} onClick={() => decide(true)}>Yes</Button>
        <Button variant="secondary" disabled={props.busy} onClick={() => decide(false)}>No</Button>
      </div>
    </div>
  );
}
