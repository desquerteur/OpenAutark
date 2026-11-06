// Props every ask widget receives from AskBlock (the calm shell around it).
// Owns: the widget ↔ shell contract. Never: widget logic.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';

export interface AskWidgetProps {
  block: UiBlock;
  /** Stable key for local drafts (never lose input across navigation/restarts). */
  draftKey: string;
  /** Sends the answer; true on success (the shell then shows the receipt), false on failure (toast shown). */
  submit(answer: unknown): Promise<boolean>;
  busy: boolean;
  /** Snoozes the to-do behind this widget until `until` (epoch ms); absent when there is none. */
  snooze?(until: number): Promise<boolean>;
}
