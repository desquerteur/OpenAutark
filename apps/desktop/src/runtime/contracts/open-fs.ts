// B-044 open file system: the runtime's one prompt set (with the person's own versions in <data>/prompts) and
// the generated maps of <data> as members of RuntimeServices, and the settings file's notice and held sections on SettingsService
// (merged by module augmentation, like the other late additions in this folder). Created in compose/services.ts; the maps stop in compose/lifecycle.ts.
// Owns: the member declarations only.

import type { PromptTemplates } from '../context/templates.ts';
import type { RootMaps } from '../root/readme.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** The shipped prompts plus the person's own versions (<data>/prompts/<name>.md; any prompt, rules.md included). Missing = not wired (fakes). */
    prompts?: PromptTemplates;
    /** <data>/README.md and agents/README.md, kept current. Missing = not wired (fakes). */
    rootMaps?: RootMaps;
  }
  interface SettingsService {
    /** The quiet notice of <data>/settings.json (a section not used), when there is one (settings/service.ts). */
    notice?(): string | undefined;
    /** The sections of settings.json not applied right now, kept there as written; an update of one replaces it (settings/service.ts). */
    held?(): string[];
    /** Stops hearing about edits of settings.json (stop step 'settings file', compose/lifecycle.ts). */
    close?(): void;
  }
}

export type { PromptTemplates, RootMaps };
