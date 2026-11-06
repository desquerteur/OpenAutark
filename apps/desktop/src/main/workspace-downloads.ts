// Where a download of the person's website tabs goes (B-044 decision 20): into
// <workspace>/downloads/personal under the name the site suggests – made safe for every OS (no path
// parts, no reserved characters or device names, at most 120 characters with the extension kept)
// and unique in that folder ("report (2).pdf"). Never a save dialog, never another folder.
// Owns: the folder's name rule and the file name. Never: imports electron or writes files.

import path from 'node:path';

/** The personal downloads folder of a workspace. */
export function personalDownloads(workspace: string): string {
  return path.join(workspace, 'downloads', 'personal');
}

const RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/** A safe file name from the site's suggestion. */
export function downloadName(suggested: string): string {
  const base = (suggested.split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  let name = base || 'download';
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const ext = path.extname(name).slice(0, 16);
    name = `${name.slice(0, 120 - ext.length)}${ext}`;
  }
  return name;
}

/** A file in `dir` for the suggested name that `taken` does not know yet: name, then "name (2)", "name (3)" … */
export function uniqueDownload(dir: string, suggested: string, taken: (file: string) => boolean): string {
  const name = downloadName(suggested);
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length) || 'download';
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, n === 1 ? name : `${stem} (${n})${ext}`);
    if (!taken(file)) return file;
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}
