// Owns: the normal packaging CLI plus static NSIS extraction for local Windows builds.
// AF-003: a loud warning when the package will not be able to send feedback (no resources/feedback/receiver.json –
// `wf feedback setup` writes it); the 0.3.3 release shipped without one, so every report stayed on the sender's PC.
// Never: disables security checks, bypasses a failed CRC, or changes the installed app/profile.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enableStaticUninstaller } from './nsis-build.mjs';

const receiver = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'feedback', 'receiver.json');
if (!existsSync(receiver)) {
  console.warn([
    '',
    'WARNING: resources/feedback/receiver.json is missing – this package cannot send feedback.',
    '         Reports will only be saved on the user\'s PC ("Sending is not set up in this version").',
    '         Run `wf feedback setup --project <id> --api-key <key> --service-account <file.json>` on the team PC first.',
    '',
  ].join('\n'));
}

if (process.platform === 'win32') enableStaticUninstaller(createRequire(import.meta.url));
await import('electron-builder/cli.js');
