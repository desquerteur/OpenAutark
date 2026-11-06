// F-51 start paths as a member of RuntimeServices (merged by module augmentation, like the other late additions
// in this folder): the team pattern library.
// Owns: the member declaration only. Never: behaviour (runtime/patterns).

import type { PatternLibrary } from '../patterns/library.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** F-51: built-in, saved and imported team patterns (compose/team-start.ts). */
    patterns?: PatternLibrary;
  }
}

export type { PatternLibrary };
