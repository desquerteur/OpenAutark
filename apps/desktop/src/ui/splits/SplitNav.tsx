// An agent's splits in the team sidebar (B-057 S18 b): inside the same expansion the person opens for the agent's
// reports (team/TeamNav.tsx Branch, below them – never opened by itself), a height-limited, internally scrolling block
// of fixed 34 px rows for its active and recently finished groups (split-text.ts sidebarGroups, shown oldest first so a
// new group appends at the bottom; it opens scrolled to its end, the open split's row kept in view). Each group starts
// with one static 24 px line naming its goal (muted, one line with an ellipsis, the full goal in its tooltip – rows of
// several groups read "#1 …" alike without it; it sticks to the block's top while its rows pass under it, so a group
// scrolled half away still says what it is for), then per part a row: the status icon slot, "#3 title" and the duration
// in a fixed slot; a row opens the
// split's page (#/team/<agentId>/split/<splitId>), the open one has the selected background only. The collapsed agent row shows the running count in its reserved cell
// (SplitCount – the cell is always there, so nothing moves when the count comes or goes).
// Owns: these rows, the goal lines and the count cell. Never: expands a row, or adds rows above the agent row.

import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import type { SplitView } from '../../shared/model/splits.ts';
import { Icon } from '../lib/ui.tsx';
import { agentName } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { useContextMenu } from '../lib/context-menu.tsx';
import { SplitIcon } from './SplitRows.tsx';
import { runningSplits } from '../team/org-state.ts';
import { agentGroups, watchSplits } from './split-model.ts';
import { splitMenu } from './split-menu.ts';
import { groupDone, partLabel, splitDuration } from './split-text.ts';

/** The newest groups of all agents the sidebar reads once (then events, the activity rule and reconnects keep them). */
const NAV_LIMIT = 60;

/** While the team sidebar is shown: every agent's newest groups (one read). */
export function useSplitNav(): void {
  useEffect(() => watchSplits({ limit: NAV_LIMIT }), []);
}

/** Does the agent have split rows (or running splits whose groups are on their way)? Its caret then has a use. */
export function hasSplits(agentId: string): boolean {
  return (runningSplits.value.get(agentId) ?? 0) > 0 || agentGroups(agentId).length > 0;
}

/** The agent row's reserved count cell: the running splits while the row is closed, else empty (same box). */
export function SplitCount(props: { agentId: string; shown: boolean }) {
  const count = props.shown ? runningSplits.value.get(props.agentId) ?? 0 : 0;
  return (
    <span class="team-split-count tabular" title={count ? `${count} ${count === 1 ? 'split' : 'splits'} running` : undefined}>
      {count > 0 && <><Icon name="git-branch" size={11} />{count}</>}
    </span>
  );
}

function SplitNavRow(props: { split: SplitView; agentId: string; depth: number; active: boolean }) {
  const { split, active } = props;
  const menu = useContextMenu(() => splitMenu(split));
  return (
    <button type="button" class={`team-split-row${active ? ' active' : ''}`} style={{ '--depth': String(props.depth) }} {...menu}
      aria-current={active ? 'page' : undefined} title={split.title} onClick={() => go.split(props.agentId, split.id)}>
      <SplitIcon status={split.status} />
      <span class="team-split-title">{partLabel(split)}</span>
      <span class="team-split-time tabular">{splitDuration(split)}</span>
    </button>
  );
}

/** The split rows under an agent (its newest active and recent groups in the order they were made – a new group comes
 *  in at the bottom, the rows above it stay; parts in order). When the block appears (the person opened it) its scroller
 *  starts at its end – the newest group, the one most likely at work; the open split's row is kept in view (also when
 *  the page changes to another split). Nothing outside the block moves. */
export function SplitNavRows(props: { agentId: string; depth: number; activeSplitId?: string }) {
  const groups = agentGroups(props.agentId).reverse();
  const box = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const shown = groups.length > 0;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) { placed.current = false; return; }
    /** Once it has its size (a shell that mounts hidden lays it out later): the open split's row in view (scrolled only
     *  when it is not – a click on a row never scrolls), else – the first time – the end. */
    const place = (): boolean => {
      if (!el.clientHeight) return false;
      const active = el.querySelector<HTMLElement>('.team-split-row.active');
      if (active) {
        const top = active.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        const cover = el.querySelector<HTMLElement>('.team-split-goal')?.offsetHeight ?? 0; // the goal line that sticks at the top
        if (top - cover < el.scrollTop) el.scrollTop = top - cover;
        else if (top + active.offsetHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + active.offsetHeight - el.clientHeight;
      } else if (!placed.current) el.scrollTop = el.scrollHeight;
      placed.current = true;
      return true;
    };
    if (place()) return;
    const sized = new ResizeObserver(() => { if (place()) sized.disconnect(); });
    sized.observe(el);
    return () => sized.disconnect();
  }, [shown, props.activeSplitId]);
  if (!shown) return null;
  return (
    <div ref={box} class="team-splits" role="group" aria-label={`Splits of ${agentName(props.agentId)}`}>
      {groups.map((group) => (
        <div key={group.id} class="team-split-group" role="group" aria-label={`${group.goal} · ${groupDone(group)}`}>
          <div class="team-split-goal" style={{ '--depth': String(props.depth) }} title={group.goal} aria-hidden="true">
            <span class="team-split-goal-text">{group.goal}</span>
          </div>
          {group.splits.slice().sort((a, b) => a.idx - b.idx).map((split) => (
            <SplitNavRow key={split.id} split={split} agentId={props.agentId} depth={props.depth} active={split.id === props.activeSplitId} />
          ))}
        </div>
      ))}
    </div>
  );
}
