// Build helper for the iPhone web app (B-078 follow-up): bundles src/ui/hosted/shell.ts (esm) and src/ui/hosted/sw.ts
// (iife) for Safari 17 into apps/website/src/app/{shell.js,sw.js} – generated files the website build only copies, so the
// site stays dependency-free and the app has one source. The first line of each is `// autark-hosted-src: <hash>`, the
// SHA-256 over every source file esbuild read for it (path and content), so test/unit/hosted/bundle-fresh.test.ts fails
// when a copy is older than src/ui/hosted.
// Owns: those two bundles and their source hash. Never: the website's own files.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const HOSTED_ENTRIES = [
  { entry: 'src/ui/hosted/shell.ts', file: 'shell.js', format: 'esm' },
  { entry: 'src/ui/hosted/sw.ts', file: 'sw.js', format: 'iife' },
];
export const BANNER = '// autark-hosted-src: ';

/** The hash over the inputs esbuild read (sorted, LF-normalised so a checkout's line endings do not matter). */
export async function sourceHash(root, inputs) {
  const hash = createHash('sha256');
  for (const file of [...inputs].filter((name) => !name.includes('node_modules')).sort()) {
    hash.update(`${file}\n`).update((await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n')).update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

/** Bundles one entry in memory: its code and the hash of its sources. */
export async function bundleHosted(root, { entry, format }, { minify = true } = {}) {
  const result = await build({
    absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true, format, platform: 'browser',
    target: 'safari17', minify, legalComments: 'none', logLevel: 'warning',
  });
  return { code: result.outputFiles[0].text, hash: await sourceHash(root, Object.keys(result.metafile.inputs)) };
}

/** Writes both bundles into the website (`out` defaults to apps/website/src/app). */
export async function writeHosted(root, { out = path.join(root, '..', 'website', 'src', 'app'), minify = true } = {}) {
  await mkdir(out, { recursive: true });
  const written = [];
  for (const target of HOSTED_ENTRIES) {
    const { code, hash } = await bundleHosted(root, target, { minify });
    await writeFile(path.join(out, target.file), `${BANNER}${hash} (generated from apps/desktop/${target.entry} by scripts/build.mjs --only hosted)\n${code}`);
    written.push({ file: target.file, hash });
  }
  return written;
}
