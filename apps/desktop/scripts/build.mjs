// Builds the app into ./app with esbuild (one bundle per process).
//   node scripts/build.mjs            all targets
//   node scripts/build.mjs --only ui  one target (main, preload, runtime, cli, wf, meet, ui, hosted)
//   node scripts/build.mjs --dev      inline sourcemaps, no minify
// Output layout (loaded by Electron and electron-builder):
//   app/main.cjs  app/preload.cjs  app/runtime.mjs  app/runtime-cli.mjs  app/wf.mjs  app/meet.mjs  app/ui/**

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swPrecacheDefines } from './sw-precache.mjs';
import { writeDocs } from './rpc-docs.mjs';
import { writeHosted } from './hosted-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'app');
const args = process.argv.slice(2);
const dev = args.includes('--dev');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Feedback (B-055): nothing is compiled in – the runtime reads the team's receiver from resources/feedback/receiver.json
// (written by `wf feedback setup`, shipped with resources/**). The old WORKFORCE_FEEDBACK_ORIGIN endpoint is gone.

const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'linked',
  logLevel: 'warning',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
};

// Node bundles keep heavyweight or file-based deps external (installed as production deps).
const nodeExternal = ['electron', 'electron-updater', 'playwright-core', 'pdfjs-dist', '@thednp/dommatrix'];
const esmBanner = { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" };

const targets = {
  main: () => build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'app/main.cjs', platform: 'node', format: 'cjs', target: 'node24', external: nodeExternal }),
  preload: () => build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'app/preload.cjs', platform: 'node', format: 'cjs', target: 'node24', external: ['electron'] }),
  runtime: () => build({ ...common, entryPoints: ['src/runtime/entry-electron.ts'], outfile: 'app/runtime.mjs', platform: 'node', format: 'esm', target: 'node24', external: nodeExternal, banner: esmBanner }),
  cli: () => build({ ...common, entryPoints: ['src/runtime/cli.ts'], outfile: 'app/runtime-cli.mjs', platform: 'node', format: 'esm', target: 'node24', external: nodeExternal, banner: esmBanner }),
  // C7: the wf terminal client – self-contained (node: builtins and the global WebSocket only).
  wf: () => build({ ...common, entryPoints: ['src/runtime/wf-cli/wf.ts'], outfile: 'app/wf.mjs', platform: 'node', format: 'esm', target: 'node24' }),
  // The meeting server (services/remote-relay) in one file, so a PC with a public address runs it from the app
  // (`node app/meet.mjs` or the app's Node); its `ws` comes from this package when the service has no install.
  meet: () => build({
    ...common, entryPoints: [path.join(root, '..', '..', 'services', 'remote-relay', 'src', 'main.ts')], outfile: 'app/meet.mjs',
    platform: 'node', format: 'esm', target: 'node24', banner: esmBanner, nodePaths: [path.join(root, 'node_modules')],
  }),
  ui: async () => {
    const app = await build({
      ...common,
      entryPoints: { main: 'src/ui/main.tsx' },
      outdir: 'app/ui',
      platform: 'browser',
      format: 'esm',
      target: 'chrome140',
      splitting: true,
      chunkNames: 'chunks/[name]-[hash]',
      jsx: 'automatic',
      jsxImportSource: 'preact',
      loader: { '.svg': 'text', '.woff2': 'file' },
      metafile: true, // for the service worker's precache list
    });
    // DEV5A: sw.js precaches main.css and the chunks main.js imports statically, under a cache
    // named by their content (scripts/sw-precache.mjs); paths are relative to root (the cwd here).
    const precache = await swPrecacheDefines({ metafile: app.metafile });
    await build({ ...common, define: { ...common.define, ...precache }, entryPoints: ['src/ui/pwa/sw.ts'], outfile: 'app/ui/sw.js', platform: 'browser', format: 'iife', target: 'chrome140' });
    await build({ ...common, entryPoints: ['src/ui/sandbox/wf.ts'], outfile: 'app/ui/sandbox/wf.js', platform: 'browser', format: 'iife', target: 'chrome140' });
    // D13: the microphone tap's AudioWorklet module (lib/microphone.ts addModule('pcm-worklet.js'), next to index.html)
    await build({ ...common, entryPoints: ['src/ui/lib/pcm-worklet.ts'], outfile: 'app/ui/pcm-worklet.js', platform: 'browser', format: 'esm', target: 'chrome140' });
    await cp('src/ui/index.html', 'app/ui/index.html');
    await cp('src/ui/pwa/manifest.webmanifest', 'app/ui/manifest.webmanifest');
    await cp('assets/icons', 'app/ui/icons', { recursive: true });
    await cp('assets/icon.png', 'app/ui/icon.png');
    await cp('assets/icon-maskable.png', 'app/ui/icon-maskable.png');
  },
  // The iPhone web app's shell and service worker (src/ui/hosted) as generated files of the website (apps/website/src/app),
  // with a source hash in their first line (scripts/hosted-bundle.mjs; test/unit/hosted/bundle-fresh.test.ts).
  hosted: async () => { await writeHosted(root, { minify: !dev }); },
};

process.chdir(root);
if (!only) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const names = only ? only.split(',') : Object.keys(targets);
const started = Date.now();
// rpc.methods tells each method's params from this generated file: the runtime bundle has no types left. A failure keeps the last one.
if (names.includes('runtime') || names.includes('cli')) await writeDocs(root).catch((error) => console.warn(`method docs not written: ${error}`));
for (const name of names) {
  if (!targets[name]) throw new Error(`Unknown build target: ${name}`);
  await targets[name]();
}
await writeFile(path.join(out, 'build.json'), JSON.stringify({ version: pkg.version, builtAt: new Date().toISOString(), dev }, null, 2));
console.log(`built ${names.join(', ')} in ${Date.now() - started} ms`);
