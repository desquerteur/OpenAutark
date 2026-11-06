// The caller's own identity in this window – the one the profile button shows (shell/ProfileMenu.tsx →
// HumanAvatar): the profile name ("You" without one) and the profile photo, else the caller's own
// directory avatar when it has one (a person's device), else the name's initials. Every place that names
// or draws 'human' (the profile button, Team › People, "Reports to" choices, an agent under the owner,
// message authors) takes it from here, so the owner is never "CEO"/"C" in one place and "You"/"Y" in
// another (the runtime's "CEO" fallback names the owner to the people of the organisation only).
// Owns: that rule. Never: reads signals or the runtime (callers pass the profile and the directory row).

import type { Avatar } from '../../shared/model/org.ts';
import type { Person } from '../../shared/model/people.ts';
import type { Profile } from '../../shared/model/system.ts';

export interface SelfIdentity { name: string; avatar?: Avatar }

type ProfileLike = Partial<Pick<Profile, 'name' | 'avatarFileId'>> | undefined;

/** The caller's name and avatar (undefined avatar: initials of the name). */
export function selfIdentity(profile: ProfileLike, row?: Pick<Person, 'avatar'>): SelfIdentity {
  const name = profile?.name?.trim() || 'You';
  const avatar: Avatar | undefined = profile?.avatarFileId ? { kind: 'image', value: profile.avatarFileId } : row?.avatar?.value ? row.avatar : undefined;
  return avatar ? { name, avatar } : { name };
}

/** The directory with the caller's own row ('human') named and drawn as selfIdentity says. */
export function withSelf<T extends Pick<Person, 'id' | 'name' | 'avatar'>>(people: readonly T[], profile: ProfileLike): T[] {
  return people.map((person) => {
    if (person.id !== 'human') return person;
    const self = selfIdentity(profile, person);
    return { ...person, name: self.name, avatar: self.avatar ?? person.avatar };
  });
}
