// B-055 Q4: the feedback cell's button (megaphone, tooltip "Feedback") – the same in every view: the
// desktop frame's cell right before the caption controls (shell/WindowBar.tsx) and the phone's top row
// before Profile (shell/MobileShell.tsx). Pointer down takes the window's screenshot at once
// (draft.ts takeShot – before anything opens, so the menu is never in it); a short click opens or
// closes the menu (FeedbackMenu.tsx), a press held HOLD_MS or longer is talk (press.ts): dictation
// starts, a slim waveform pill shows under the cell (TalkPill.tsx), and the release stops it and
// opens the menu with the words in the field. Without dictation here every press is a click.
// Enter/Space toggles; Escape during talk discards it. The look changes only colour (pressed
// while the menu is open), never the box.
// Owns: the button, its press handling and the talk's dictation. Never: the menu or sending.

import { signal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from '../lib/icons.tsx';
import { feedbackOpen } from '../lib/shell-state.ts';
import { settings } from '../lib/store.ts';
import { DictationButton, panelDictation, panelDictationAvailable } from './bridge.ts';
import type { DictationState } from './bridge.ts';
import { appendDraftText, shotSettled, takeShot } from './draft.ts';
import { closeFeedback, feedbackAnchor, here, menuShown, showFeedbackNow } from './popover-state.ts';
import { PressTracker } from './press.ts';
import type { TapSource } from './press.ts';
import { TalkPill } from './TalkPill.tsx';

/** The cell's talk: its dictation state and the hold that shows the pill. */
export const talkState = signal<DictationState>('idle');
export const talkError = signal<string | null>(null);
const holding = signal(false);

let talk: DictationButton | null = null;
function cellDictation(): DictationButton {
  talk ??= new DictationButton(panelDictation, {
    state: (state) => { talkState.value = state; },
    error: (message) => { talkError.value = message; },
    text: (text) => appendDraftText(text),
    language: () => settings.peek()?.profile.language,
  });
  return talk;
}

const tapped = (source: TapSource) => {
  if (feedbackOpen.peek() !== null) { closeFeedback(); return; }
  talkError.value = null; // an earlier talk's error is not this opening's
  if (source === 'pointer') { showFeedbackNow(); return; }
  // Enter/Space: no press took the screenshot yet – take it, then open (the menu is never in it)
  void takeShot(here());
  void shotSettled().then(() => { if (feedbackOpen.peek() === null) showFeedbackNow(); });
};

export function FeedbackButton(props: { iconSize?: number }) {
  const ref = useRef<HTMLButtonElement>(null);
  const tracker = useRef<PressTracker | null>(null);
  tracker.current ??= new PressTracker({
    press: () => { if (feedbackOpen.peek() === null) void takeShot(here()); },
    tap: tapped,
    holdStart: () => { holding.value = true; talkError.value = null; cellDictation().beginHold(); },
    holdEnd: () => { holding.value = false; cellDictation().endHold(); if (feedbackOpen.peek() === null) showFeedbackNow(); },
    holdCancel: () => { holding.value = false; cellDictation().cancel(); },
  }, { canHold: panelDictationAvailable });
  const press = tracker.current;

  useEffect(() => {
    const element = ref.current;
    feedbackAnchor.value = element;
    return () => { if (feedbackAnchor.peek() === element) feedbackAnchor.value = null; };
  }, []);

  // Escape ends a talk without words (the field never gets them).
  useEffect(() => {
    if (!holding.value) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); press.cancel(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [holding.value]);

  const open = menuShown.value;
  return (
    <>
      <button ref={ref} type="button" class={`icon-button frame-header-button feedback-toggle${open ? ' selected' : ''}`}
        aria-label="Feedback" title="Feedback" aria-haspopup="dialog" aria-expanded={open}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* not capturable */ }
          press.down();
        }}
        onPointerUp={() => press.up()}
        onPointerCancel={() => press.cancel()}
        onContextMenu={(event) => event.preventDefault()} // a long press opens no menu on a phone
        onClick={(event) => { if (event.detail === 0) press.key(); }}>
        <Icon name="megaphone" size={props.iconSize ?? 18} />
      </button>
      {holding.value && <TalkPill anchor={ref.current} live={talkState.value === 'listening'} />}
    </>
  );
}
