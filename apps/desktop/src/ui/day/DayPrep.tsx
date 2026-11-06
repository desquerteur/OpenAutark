// An agent's preparation of a person's to-do (B-041 §3.2, todos.prepare → task.prep), host-rendered
// in the expanded row: "Prepared by Mara: <note>" and up to five links. The note is plain text
// (never markdown or HTML an agent could dress up), links open in the system browser and only
// http(s) addresses become links; the prep never ticks the to-do off.
// Owns: that line. Never: writes the prep (agents do, through the runtime's tool).

import type { TaskPrep } from '../../shared/model/calendar.ts';
import { agentName } from '../lib/store.ts';
import { openExternal } from '../lib/platform.ts';

const WEB = /^https?:\/\//i;

/** "Prepared by Mara" – the row's short meta. */
export function prepByline(prep: TaskPrep | undefined): string | undefined {
  return prep ? `Prepared by ${agentName(prep.byAgentId)}` : undefined;
}

export function DayPrep(props: { prep: TaskPrep | undefined }) {
  const { prep } = props;
  if (!prep || (!prep.note && !prep.links?.length)) return null;
  const links = (prep.links ?? []).filter((link) => WEB.test(link.url));
  return (
    <div class="day-prep">
      <div class="day-prep-text">
        <p><span class="day-prep-by">{prepByline(prep)}:</span> {prep.note}</p>
        {links.length > 0 && (
          <ul class="day-prep-links">
            {links.map((link) => (
              <li key={link.url}>
                <a href={link.url} title={link.url} onClick={(event) => { event.preventDefault(); openExternal(link.url); }}>{link.label || link.url}</a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
