// Today's briefing at the top of My day: its written lines (at most three) and, muted, what happened overnight.
// Nothing when there is none. Owns: this block. Never: writes the briefing (the runtime does).

import { briefing, dayZone } from '../lib/day-store.ts';
import { briefingFor, briefingLines, overnightFacts } from './day-briefing.ts';
import { today } from './day-state.ts';

export function DayBriefing() {
  const brief = briefingFor(briefing.value, today.value);
  if (!brief) return null;
  const lines = briefingLines(brief);
  const facts = overnightFacts(brief, dayZone.value);
  if (!lines.length && !facts.length) return null;
  return (
    <div class="day-briefing" aria-label="Briefing">
      {lines.map((line, index) => <p key={index} class="day-briefing-line">{line}</p>)}
      {facts.length > 0 && <p class="day-briefing-facts">{facts.join(' · ')}</p>}
    </div>
  );
}
