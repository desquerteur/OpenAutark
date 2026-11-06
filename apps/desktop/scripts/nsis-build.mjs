// Owns: electron-builder 26.15.3's build-time uninstaller extraction on Windows.
// Never: executes generated build helpers, alters installed dependencies, or changes OS policy.
import path from 'node:path';
import { UninstallerReader } from './vendor/nsis-reader.ts';

export function enableStaticUninstaller(require) {
  const { version } = require('app-builder-lib/package.json');
  if (version !== '26.15.3') throw new Error('Review the static NSIS adapter before changing electron-builder.');
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm.js');
  // This pinned call only writes the uninstaller. Use upstream's data reader instead of
  // starting the just-compiled generator. Signing and final NSIS compilation stay with builder.
  WineVmManager.prototype.exec = async function (file, args = [], options = {}) {
    if (options.env?.__COMPAT_LAYER !== 'RunAsInvoker' || args.length !== 0 || path.extname(file) !== '.exe') {
      throw new Error('Unexpected NSIS build-helper call; refusing to execute it.');
    }
    const output = path.join(path.dirname(file), `${path.basename(file, 'exe')}__uninstaller.exe`);
    await UninstallerReader.exec(file, output);
    console.info('NSIS uninstaller reconstructed as data; original CRC32 verified; no generator execution.');
    return '';
  };
}
