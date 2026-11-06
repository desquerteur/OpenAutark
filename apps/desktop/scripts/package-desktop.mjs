// Owns: the normal packaging CLI plus static NSIS extraction for local Windows builds.
// Never: disables security checks, bypasses a failed CRC, or changes the installed app/profile.
import { createRequire } from 'node:module';
import { enableStaticUninstaller } from './nsis-build.mjs';

if (process.platform === 'win32') enableStaticUninstaller(createRequire(import.meta.url));
await import('electron-builder/cli.js');
