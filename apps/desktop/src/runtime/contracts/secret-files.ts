// B-044: the vault's metadata files (<data>/secrets/<id>.md) as a member of RuntimeServices (merged by module
// augmentation, like the other late additions in this folder). Implemented by runtime/secrets/files.ts, created and
// started in compose/services.ts, stopped by the compose/lifecycle.ts stop step 'secret files'.
// Owns: the member declaration only.

import type { SecretFiles } from '../secrets/files.ts';

declare module '../contracts.ts' {
  interface RuntimeServices {
    /** The metadata files of the vault: "value missing" entries, quiet notices, the folder. Missing = not wired (fakes). */
    secretFiles?: SecretFiles;
  }
}

export type { SecretFiles };
