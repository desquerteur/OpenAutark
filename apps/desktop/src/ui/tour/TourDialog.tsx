// B-055: the feedback tour as a dialog over the app (replay from Settings › Feedback "Watch how it
// works", openTour() in open.ts). The first run shows the same player as its own first step
// (ui/onboarding/FirstRun.tsx). A native modal dialog: Esc, the × and Continue close it (closeTour);
// a click on the backdrop too. The player starts at its poster on every opening (it mounts afresh).
// Owns: mounting the player while `tourOpen` is true. Never: the timeline or the scene.

import { useLayoutEffect, useRef } from 'preact/hooks';
import { closeTour, tourOpen } from './open.ts';
import { TOUR_TITLE, TourPlayer } from './TourPlayer.tsx';

export function TourDialog() {
  if (!tourOpen.value) return null;
  return <TourModal />;
}

function TourModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => { if (dialog?.open) dialog.close(); };
  }, []);
  return (
    <dialog
      ref={ref} class="dialog tour-dialog" aria-label={TOUR_TITLE}
      onCancel={(event) => { event.preventDefault(); closeTour(); }}
      onClick={(event) => { if (event.target === ref.current) closeTour(); }}
    >
      <TourPlayer mode="dialog" onDone={closeTour} />
    </dialog>
  );
}
