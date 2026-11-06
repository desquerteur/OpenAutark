// Free text → the parts of the person's own to-do: title (first line), notes (the whole text when the title does not
// hold it) and a plain "Done" widget (confirm). No guessing of widgets or times: the person (or an agent) picks
// another widget with "Show as…", and an agent that helps reads the text itself.
// Owns: those parts. Never: creates a task or asks a model.

import { WorkforceError } from '../../shared/errors.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { excerpt } from '../../shared/text/chat-names.ts';
import type { HumanReason } from '../../shared/model/tasks.ts';
import type { RuntimeServices } from '../contracts.ts';

/** The parts of a human to-do typed as free text. */
export interface TodoDraft { title: string; notes: string; widget: UiBlock; humanReason: HumanReason; dueAt?: number }

/** The draft of a typed to-do (`s` kept for callers; nothing is read from it). */
export function quickDraft(_s: Pick<RuntimeServices, 'clock'>, text: string): TodoDraft {
  const trimmed = text.trim();
  if (!trimmed) throw new WorkforceError('bad_request', 'A to-do needs text.');
  const title = excerpt(trimmed.split(/\r?\n/)[0], 120);
  return { title, notes: notesFor(trimmed, title), widget: { type: 'confirm', instructions: title }, humanReason: 'physical' };
}

/**
 * B-078 (owner 06.11.: "mehrere Textfelder, die richtig riesig sind pro Task"): a quick task's notes hold only what
 * the title does not – the lines after a whole first line, else (a cut first line) the whole text.
 */
export function restNotes(text: string, title: string): string {
  const trimmed = text.trim();
  const [first, ...rest] = trimmed.split(/\r?\n/);
  if (excerpt(first.trim(), Infinity) !== title) return trimmed;
  return rest.join('\n').trim();
}

/** Typed text is kept whole: the notes hold it when the title does not (several lines, or cut). */
export function notesFor(text: string, title: string): string {
  return text.includes('\n') || title !== excerpt(text, Infinity) ? text : '';
}
