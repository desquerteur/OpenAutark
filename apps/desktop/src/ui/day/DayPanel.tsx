// My day in the side pane (the pane's "My day" tab, workspace/WorkspacePane.tsx): today's briefing, the input row, the
// list and the overview under it (with what is ahead today in words: no calendar grid here – the column is about 400 px).
// The full view is DayView.tsx.
// Owns: My day's compact column. Never: a copy of the to-dos or data loading of its own.

import { ForYouList } from '../tasks/ForYouList.tsx';
import { DayBriefing } from './DayBriefing.tsx';
import { DayInput } from './DayInput.tsx';
import { DayOverview } from './DayOverview.tsx';

export function DayPanel() {
  return (
    <div class="day-panel">
      <DayBriefing />
      <DayInput compact />
      <ForYouList />
      <DayOverview calendar />
    </div>
  );
}
