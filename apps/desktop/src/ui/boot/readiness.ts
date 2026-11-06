// Restart readiness of the window (desktop updater, web-genui/H11): the app may restart for an
// update only when nothing the human is doing would be interrupted.
// Owns: the pure rule. Never: reads the DOM or signals (boot/desktop.ts collects the facts).

export interface ReadinessFacts {
  /** Current route view; Settings counts as "busy" (forms may be half filled). */
  view: string;
  /** Any modal <dialog> or overlay panel (palette, new chat, feedback) open. */
  overlayOpen: boolean;
  /** The visible composer has text or attachments. */
  composerDirty: boolean;
  /** Dictation or a live voice conversation is running. */
  listening: boolean;
}

export function isRestartReady(facts: ReadinessFacts): boolean {
  return facts.view !== 'settings' && !facts.overlayOpen && !facts.composerDirty && !facts.listening;
}

/** Calls `send` only when the value differs from the last one sent (main wants changes only). */
export function changeNotifier(send: (ready: boolean) => void): (ready: boolean) => void {
  let last: boolean | undefined;
  return (ready) => {
    if (ready === last) return;
    last = ready;
    send(ready);
  };
}
