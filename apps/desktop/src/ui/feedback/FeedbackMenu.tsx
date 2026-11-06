// B-055 Q4: the feedback menu – a ~360 px popover hanging right-aligned under the header's feedback
// cell (FeedbackButton.tsx, popover-state.ts feedbackAnchor), in the top layer (lib/popover.tsx:
// portalled, fixed), so opening it moves nothing; on a phone the popover is a bottom sheet
// (mobile.css). Outside click, Escape or the cell close it. Mounted once by the shell's overlays,
// together with "Paint over" (PaintEditor.tsx). An opening that did not come from the cell (the
// command palette, /feedback, Settings) shows the menu only after its screenshot: two frames for
// a closing palette and the side browser's view to come back, then the shot (bounded).
// Owns: the menu host. Never: the form's content or sending (FeedbackPanel.tsx).

import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import { Popover } from '../lib/popover.tsx';
import { shotSettled, takeShot } from './draft.ts';
import { FeedbackForm } from './FeedbackPanel.tsx';
import { FeedbackInbox, FeedbackInboxEntry } from './FeedbackInbox.tsx';
import { FeedbackPrivacyDialog } from './FeedbackPrivacy.tsx';
import { PaintEditor } from './PaintEditor.tsx';
import { closeFeedback, feedbackAnchor, here, menuShown, watchFeedbackOpen } from './popover-state.ts';

const frame = () => new Promise<void>((resolve) => {
  requestAnimationFrame(() => resolve());
  setTimeout(resolve, 100); // a window that does not paint (hidden) still opens
});

const inboxOpen = signal(false); // keep the dialog open when the shell changes to the phone layout

async function prepare(): Promise<void> {
  await frame();
  await frame();
  void takeShot(here());
  await shotSettled(); // bounded: a slow capture never keeps the menu away
}

export function FeedbackMenu() {
  useEffect(() => watchFeedbackOpen(prepare), []);
  return (
    <>
      <Popover anchor={feedbackAnchor.value} open={menuShown.value} onClose={closeFeedback} placement="bottom-end" width={360}
        class="feedback-menu" label="Feedback">
        <FeedbackForm onClose={closeFeedback} />
        <FeedbackInboxEntry shown={menuShown.value} onOpen={() => { closeFeedback(); inboxOpen.value = true; }} />
      </Popover>
      <PaintEditor />
      <FeedbackPrivacyDialog />
      <FeedbackInbox open={inboxOpen.value} onClose={() => { inboxOpen.value = false; }} />
    </>
  );
}
