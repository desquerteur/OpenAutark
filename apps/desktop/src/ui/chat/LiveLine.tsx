// The chat header's live line ("Mira: cutting intro, Ava: running a command"; in a narrow sub line one
// agent's line or the names, "Mira, Ava"; on a phone "Mira is working" – live-text.ts), in the header's
// reserved sub line beside the call line (ChatHeader.tsx).
// 21.10. 17:09: the chat has no Stop button – a message (marked Important when it must reach running
// work at once) is how the person redirects an agent.
// B-048 E4.5: the line is a button for everyone who sees it – a click opens the working popover over
// the content (WorkingPopover.tsx: one row per member working here, their model · effort, note, task,
// live steps and newest words); its last entry stays the deliberate way to the separate emergency
// stop, "Stop all agent work" (shell/work-stop.ts), for whoever may stop. ChatHeader.tsx holds the
// open state, so the popover stays while one run hands over to the next.
// Owns: the line's markup. Never: stops one agent or one chat by itself.

import { useEffect } from 'preact/hooks';
import { watchWorkStop } from '../shell/work-stop.ts';

export function LiveLine(props: { text: string; short?: string; names?: string; open: boolean; onToggle: () => void }) {
  useEffect(() => { watchWorkStop(); }, []);
  // data-short / data-names: a narrow and a phone's sub line show the shorter forms (chat.css, live-text.ts);
  // the full line stays the text and the title
  const text = <span class="chat-live-text">{props.text}</span>;
  const forms = { 'data-short': props.short ?? props.text, 'data-names': props.names ?? props.short ?? props.text };
  return (
    <button type="button" class="chat-live tabular" aria-live="polite" aria-haspopup="dialog" aria-expanded={props.open}
      title={props.text} {...forms} onClick={props.onToggle}>
      {text}
    </button>
  );
}
