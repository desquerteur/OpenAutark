// A scrolled page that keeps its height when a click shortens it. Closing a disclosure with the page scrolled near its
// end leaves the scroll position past the new end, and the browser pulls everything down by the difference: the row
// just clicked leaves the pointer. So a click in the scroller sets its one child's current height as a floor, before
// the click's own handler changes anything; scrolling up gives the room back, down to where the view then ends.
// Spread on the scroller: <div class="agent-scroll" {...keptPage}><div class="agent-column">…
// Owns: that floor, kept in the child's style. Never: sets a scroll position or looks at what was clicked.

const childOf = (event: Event) => (event.currentTarget as HTMLElement).firstElementChild as HTMLElement | null;

export const keptPage = {
  onClickCapture(event: MouseEvent): void {
    const page = childOf(event);
    if (page) page.style.minHeight = `${page.getBoundingClientRect().height}px`;
  },
  onScroll(event: Event): void {
    const page = childOf(event);
    if (!page?.style.minHeight) return;
    const scroller = event.currentTarget as HTMLElement;
    // rounded up from the real box: a floor a fraction short of the view's end (clientHeight rounds, at 175 % display scale
    // too far down) makes the browser scroll by that fraction, which fires this again: the page would slide on its own
    const viewEnd = Math.ceil(scroller.scrollTop + scroller.getBoundingClientRect().height);
    if (viewEnd < parseFloat(page.style.minHeight)) page.style.minHeight = `${viewEnd}px`;
  },
};
