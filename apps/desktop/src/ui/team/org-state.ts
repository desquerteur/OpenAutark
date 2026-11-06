// Org data the team views need beyond the store: spaces (loaded on demand, again after every session answer – i.e.
// every reconnect – then kept fresh by 'space.upserted'), the live activity per agent, and the org tree ranked by
// the human's chat activity – with people as nodes (B-041 §8: an agent under a person sits under that person).
// Owns: the spaces signal and these computed views. Never: polls or keeps agent copies (agents come from
// store.agents).

import { computed, effect, signal } from '@preact/signals';
import type { Space } from '../../shared/model/org.ts';
import type { AgentActivity } from '../../shared/model/runs.ts';
import { rpc } from '../lib/rpc.ts';
import { can, session } from '../lib/session.ts';
import { activity, agents, conversations, settings } from '../lib/store.ts';
import { people } from '../lib/people.ts';
import { withSelf } from '../lib/self-identity.ts';
import { buildOrg, interactionScores } from './model.ts';
import { peopleOrg } from './people-model.ts';
import { runningByAgent } from '../splits/split-text.ts';

export const spaces = signal<Space[]>([]);
let wired = false;

function load(): void {
  rpc.call('spaces.list').then((list) => { spaces.value = list; }).catch(() => undefined);
}

/** Loads spaces where allowed and keeps them fresh (idempotent). */
export function ensureSpaces(): void {
  if (wired) return;
  wired = true;
  rpc.on('space.upserted', (space) => {
    const list = spaces.peek();
    const index = list.findIndex((entry) => entry.id === space.id);
    if (index === -1) spaces.value = [...list, space];
    else { const next = list.slice(); next[index] = space; spaces.value = next; }
  });
  // Runs now and after every session answer (each (re)connect): the scope may have changed.
  effect(() => {
    void session.value;
    load();
  });
}

/** agent id → its live run (if any). B-057: a split's run is not the agent's main ring or status line
 *  (runningSplits counts those for the sidebar's split cell). */
export const liveByAgent = computed(() => {
  const map = new Map<string, AgentActivity>();
  for (const entry of activity.value) if (!entry.split && !map.has(entry.agentId)) map.set(entry.agentId, entry);
  return map;
});

/** B-057: agent id → how many of its split runs run now. */
export const runningSplits = computed(() => runningByAgent(activity.value));

/** "Most used" ranking from the human's chats (30-day decay). Recomputed when chats change. */
const agentScores = computed(() => interactionScores(conversations.value, Date.now()));

/** People shown in Team: the owner sees everyone (removed access included), others the active and invited. */
export const teamPeople = computed(() => {
  const admin = can('people.save');
  return withSelf(people.value.filter((person) => admin || person.status !== 'revoked'), settings.value?.profile);
});

/** B-041 §8 – one org chart: people with the agents under them, and the agents of the top (people-model.ts peopleOrg). */
const chart = computed(() => peopleOrg(teamPeople.value, buildOrg(agents.value, agentScores.value)));

/** The org tree (managers → reports) of the active agents of the top, ranked by use (agents under a person are in peopleTree). */
export const orgTree = computed(() => chart.value.agents);

/** People as org nodes: who reports to whom, each with the agent branches under them. */
export const peopleTree = computed(() => chart.value.people);
