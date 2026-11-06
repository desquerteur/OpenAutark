// Top layer for a floating list inside an open modal <dialog> (lib/popover.tsx, lib/select.tsx): the
// list stays the dialog's descendant (outside it everything is inert) but is shown with the Popover
// API, so it paints and takes clicks above the whole dialog – a dialog that scrolls keeps its scrollbar
// strip on top of its own fixed children, which took the clicks wherever a menu reached over it.
// base.css drops the user agent's centring of [popover] so the caller's left/top place it.
// Owns: promoting and demoting one element. Never: placement, dismissal or anything outside dialogs.

/** Shows `element` in the top layer when it sits inside an open dialog; returns the cleanup. */
export function showInTopLayer(element: HTMLElement | null): (() => void) | undefined {
  if (!element?.isConnected || !element.parentElement?.closest('dialog[open]') || typeof element.showPopover !== 'function') return undefined;
  if (!element.hasAttribute('popover')) element.setAttribute('popover', 'manual');
  if (!element.matches(':popover-open')) element.showPopover();
  return () => { if (element.isConnected && element.matches(':popover-open')) element.hidePopover(); };
}
