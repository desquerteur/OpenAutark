// The optional recipient of a quick task (B-078, owner 06.11.: "vielleicht noch eben beim Plus-Symbol … erweiterte
// Einstellungen"): no chip to choose first – the composer's Plus menu carries a "Send to…" section (recipientSections:
// "Me" – every part of the post goes to My day –, the agents, the managers' branches and the teams, center-model.ts
// recipientGroups – in the owner's session also the active people of the organisation, F-52: her task goes straight
// to her, in the owner's 1:1 chat with her; never on a phone or a person's device). Only while one is picked a small
// removable chip names it (RecipientChip; a click goes back to Auto: the decision model picks the owner). A recipient
// that left (archived agent, emptied team, removed person) shows no chip (the composer clears it).
// Owns: the section builder and the chip. Never: posts or routes itself (the caller's onPick does).

import type { QuickTaskTarget } from '../../shared/model/task-center.ts';
import type { Person } from '../../shared/model/people.ts';
import { Chip } from '../lib/ui.tsx';
import type { MenuItem, MenuSection } from '../lib/ui.tsx';
import { agents } from '../lib/store.ts';
import { people as peopleList } from '../lib/people.ts';
import { isOwner } from '../lib/session.ts';
import { ME_RECIPIENT, recipientGroups, sameTarget, targetLabel } from './center-model.ts';
import type { Recipient } from './center-model.ts';

const NO_PEOPLE: readonly Person[] = [];

/** The people a quick task may go to on this connection: the owner's own session only (tasks.quickCreate refuses it elsewhere). */
export function recipientPeople(offer: boolean | undefined): readonly Person[] {
  return offer && isOwner() ? peopleList.value : NO_PEOPLE;
}

/** The Plus menu's "Send to…" sections, built when the menu opens. */
export function recipientSections(input: { value: QuickTaskTarget | undefined; onPick: (target: QuickTaskTarget | undefined) => void; people?: boolean; me?: boolean }): MenuSection[] {
  const humans = recipientPeople(input.people);
  const groups = recipientGroups(agents.peek(), humans);
  const chosen = input.value && targetLabel(input.value, agents.peek(), humans) !== undefined ? input.value : undefined;
  const item = (recipient: Recipient): MenuItem => ({
    label: recipient.label, hint: recipient.hint, checked: sameTarget(chosen, recipient.target),
    onSelect: () => input.onPick(sameTarget(chosen, recipient.target) ? undefined : recipient.target),
  });
  return [
    { title: 'Send to…', items: [...(input.me ? [item(ME_RECIPIENT)] : []), ...groups.agents.map(item)] },
    ...(groups.branches.length ? [{ title: 'Manager branches', items: groups.branches.map(item) }] : []),
    ...(groups.teams.length ? [{ title: 'Teams', items: groups.teams.map(item) }] : []),
    ...(groups.people.length ? [{ title: 'People', items: groups.people.map(item) }] : []),
  ].filter((section) => section.items.length > 0);
}

/** The picked recipient as a small removable chip; nothing while none is picked (Auto). */
export function RecipientChip(props: { value: QuickTaskTarget | undefined; onClear: () => void; people?: boolean }) {
  const label = props.value ? targetLabel(props.value, agents.value, recipientPeople(props.people)) : undefined;
  if (!label) return null;
  return (
    <Chip icon="x" tone="accent" class="recipient-chip" title="Send to: back to Auto" aria-label={`Send to ${label} – remove`} onClick={props.onClear}>
      {label}
    </Chip>
  );
}
