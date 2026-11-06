// Build helper for the PWA service worker (src/ui/pwa/sw.ts, DEV5A): what it precaches beyond its
// fixed shell (index.html, main.js, main.css …) – the CSS bundle and every chunk main.js imports
// statically, transitively; without them main.js cannot run offline. Lazy chunks (dynamic
// import(), e.g. the diagram renderers) are left to the worker's runtime cache. Plus a build id
// over those files' content: each UI build that changes them yields new sw.js bytes, so the
// browser installs a new worker that precaches the new set at once (activate drops the old cache).
// scripts/build.mjs builds the UI with `metafile: true` and passes the result to the sw.ts build
// as esbuild `define` (__SHELL_EXTRA__, __BUILD_ID__).
// Owns: computing that list and id from an esbuild metafile. Never: builds or writes anything.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {{
 *   metafile: { outputs: Record<string, { imports?: Array<{ path: string; kind: string; external?: boolean }>; cssBundle?: string }> };
 *   outdir?: string;
 *   entry?: string;
 *   read?: (file: string) => Promise<Uint8Array | string>;
 * }} input  metafile paths are relative to the build's working directory, like `outdir`.
 * @returns {Promise<{ __SHELL_EXTRA__: string; __BUILD_ID__: string }>} ready for esbuild `define`.
 */
export async function swPrecacheDefines({ metafile, outdir = 'app/ui', entry = 'main.js', read = readFile }) {
  const main = path.posix.join(outdir, entry);
  if (!metafile.outputs[main]) throw new Error(`sw precache: ${main} is not an output of this build`);
  const chunks = new Set();
  const queue = [main];
  while (queue.length) {
    for (const item of metafile.outputs[queue.shift()]?.imports ?? []) {
      if (item.kind !== 'import-statement' || item.external || item.path === main || chunks.has(item.path)) continue;
      chunks.add(item.path);
      queue.push(item.path);
    }
  }
  const css = metafile.outputs[main].cssBundle;
  const files = [...(css ? [css] : []), ...[...chunks].sort()];
  const hash = createHash('sha256');
  for (const file of [main, ...files]) hash.update(file).update(await read(file));
  const url = (file) => `/${path.posix.relative(outdir, file)}`;
  return { __SHELL_EXTRA__: JSON.stringify(files.map(url)), __BUILD_ID__: JSON.stringify(hash.digest('hex').slice(0, 12)) };
}
