// B-055 Q4: the one feedback draft of this window – the text, the window screenshot taken when the
// header cell was pressed, its marks ("Paint over") with their flattened image, and the
// "Screenshot" checkbox (on by default) – shared by the header menu and Settings › Feedback's "New
// report". It survives closing the menu until it is sent; a draft without text and without marks
// counts as empty, so the next press takes a fresh screenshot (keepsShot). Talk from the cell and
// the mic in the field both append to the text (joinText).
// AF-003: the draft also keeps its kind – "Bug" (the default) or "Idea" – chosen above the field.
// Owns: the draft state and taking its screenshot. Never: uploads, sends or draws anything.

import { signal } from '@preact/signals';
import { canCaptureWindow, captureWindow } from './bridge.ts';
import type { PaintMark, ShotDraft } from './paint.ts';

/** Where the person was when the screenshot was taken (the report's context). */
export interface DraftPlace { view?: string; conversationId?: string }

/** AF-003: the kinds the form offers (the runtime knows more: change, praise – agents may use them). */
export type DraftKind = 'bug' | 'idea';
export const DRAFT_KINDS: ReadonlyArray<{ kind: DraftKind; label: string; placeholder: string }> = [
  { kind: 'bug', label: 'Bug', placeholder: 'What happened, or what went wrong?' },
  { kind: 'idea', label: 'Idea', placeholder: 'What would you like?' },
];

export interface FeedbackDraft extends ShotDraft {
  text: string;
  marks: readonly PaintMark[];
  where: DraftPlace;
  /** AF-003: undefined = 'bug'. */
  kind?: DraftKind;
}

export const EMPTY_DRAFT: FeedbackDraft = { text: '', shot: null, painted: null, marks: [], withShot: true, where: {} };

/** The draft's kind ('bug' unless "Idea" was chosen). */
export function draftKind(draft: Pick<FeedbackDraft, 'kind'>): DraftKind {
  return draft.kind === 'idea' ? 'idea' : 'bug';
}

export const feedbackDraft = signal<FeedbackDraft>(EMPTY_DRAFT);
/** A screenshot is being taken for the draft (its thumbnail shows a placeholder meanwhile). */
export const shotTaking = signal(false);

/** The draft keeps its screenshot (text or marks would refer to it); otherwise a press retakes it. */
export function keepsShot(draft: Pick<FeedbackDraft, 'text' | 'marks' | 'shot'>): boolean {
  return draft.shot !== null && (draft.text.trim() !== '' || draft.marks.length > 0);
}

/** Dictated words after what is already there, one space between. */
export function joinText(current: string, spoken: string): string {
  const words = spoken.trim();
  if (!words) return current;
  if (!current.trim()) return words;
  return /\s$/.test(current) ? `${current}${words}` : `${current} ${words}`;
}

export function updateDraft(change: Partial<FeedbackDraft>): void {
  feedbackDraft.value = { ...feedbackDraft.peek(), ...change };
}

export function appendDraftText(spoken: string): void {
  updateDraft({ text: joinText(feedbackDraft.peek().text, spoken) });
}

/** After sending: a fresh draft (the next press takes a new screenshot). */
export function clearDraft(): void {
  feedbackDraft.value = EMPTY_DRAFT;
}

let taking: Promise<void> | null = null;

/**
 * Takes the window's screenshot for the draft unless it keeps the one it has (keepsShot) or this
 * host cannot capture (a phone). Called on the cell's pointer down, before anything opens.
 */
export function takeShot(where: DraftPlace): Promise<void> {
  if (taking) return taking;
  if (!canCaptureWindow() || keepsShot(feedbackDraft.peek())) return Promise.resolve();
  shotTaking.value = true;
  updateDraft({ shot: null, painted: null, marks: [], withShot: true, where });
  taking = captureWindow()
    .then((image) => { if (!keepsShot(feedbackDraft.peek())) updateDraft({ shot: image, painted: null, marks: [] }); })
    .finally(() => { taking = null; shotTaking.value = false; });
  return taking;
}

let painting: Promise<void> | null = null;

/** "Paint over" closes: its marks are flattened by `work`; a Send meanwhile waits for it (paintSettled). */
export function whilePainting(work: Promise<void>): Promise<void> {
  const tracked: Promise<void> = work.finally(() => { if (painting === tracked) painting = null; });
  painting = tracked;
  return tracked;
}

export function paintSettled(): Promise<void> {
  return painting ?? Promise.resolve();
}

/** Resolves when the screenshot on its way is there – or after `limitMs`, whichever is first. */
export function shotSettled(limitMs = 1500): Promise<void> {
  const pending = taking;
  if (!pending) return Promise.resolve();
  return Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, limitMs))]);
}
