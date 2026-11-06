// F-52: the people of the organisation as a member of RuntimeServices (merged by module
// augmentation, like the other late additions in this folder).
// Owns: the member declaration only. Never: behaviour (runtime/people/service.ts).

import type { PeopleService } from '../people/service.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** F-52: people next to the agents – invites, person tokens, revocation (compose/people.ts); missing = only the owner. */
    people?: PeopleService;
  }
}

export type { PeopleService };
