// Structure guards for src/ (npm run boundaries; part of npm run check):
// - the layer import rules from docs/ARCHITECTURE.md §2:
//   shared → nothing outside shared · runtime → shared (+ node) · main/preload → shared (+ electron)
//   ui → shared (+ browser libs). Nobody imports ui except the ui build;
// - oversized files (soft limit 300 lines, hard limit 450) so modules stay small;
// - the wf terminal client's own rules (C7) and shared code without platform globals (SM10);
// - F08: modules nothing imports (orphans – unreachable from ENTRIES, stylesheets through their
//   @import chain; relative imports that point at no module fail too), stylesheets without a
//   single rule, and source files whose leading comment has no "Owns:" line (db/migrations are
//   SQL text and exempt). Imports are statements: import-like text in strings or comments is none.
// The checkers work on an in-memory tree { 'src/…' posix path → text } and are exported for
// test/unit/scripts/check-boundaries.test.ts; run as a script it checks this package's src/.
// Owns: these structure rules, ENTRIES and KNOWN_ORPHANS. Never: changes or deletes a file.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const posix = path.posix;
const layers = ['shared', 'runtime', 'main', 'preload', 'ui'];
const allowed = {
  shared: ['shared'],
  runtime: ['shared', 'runtime'],
  main: ['shared', 'main'],
  preload: ['shared', 'preload'],
  ui: ['shared', 'ui'],
};
const forbiddenPackages = {
  shared: [/^node:/, /^electron/, /^preact/],
  runtime: [/^electron$/, /^preact/],
  ui: [/^node:/, /^electron/],
};

/** Modules that start a graph: the bundle entries of scripts/build.mjs and files loaded by path. */
export const ENTRIES = [
  'src/main/index.ts',
  'src/preload/index.ts',
  'src/runtime/entry-electron.ts',
  'src/runtime/cli.ts',
  'src/runtime/wf-cli/wf.ts',
  'src/ui/main.tsx',
  'src/ui/pwa/sw.ts',
  'src/ui/sandbox/wf.ts',
  'src/ui/lib/pcm-worklet.ts', // D13: the microphone's AudioWorklet module, bundled as its own file (app/ui/pcm-worklet.js)
  'src/ui/hosted/shell.ts', // the iPhone web app's shell (apps/website/src/app/shell.js, scripts/hosted-bundle.mjs)
  'src/ui/hosted/sw.ts', // its service worker (apps/website/src/app/sw.js)
];

/** Modules nothing imports yet, on purpose, with the reason. Warned about, never silently ignored. */
export const KNOWN_ORPHANS = {};

const MODULE = /\.(?:ts|tsx|mjs|css)$/;
// Statements only: an import or export at the start of a line, so import-like text in a string
// or a comment is no import; dynamic import() anywhere except on comment lines.
const STATIC_IMPORT = /^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
// A relative import with one of these endings (or none) must point at a module in the tree.
const MODULE_SPEC = /(?:^|\/)[^/.]+$|\.(?:ts|tsx|mjs|js|css)$/;
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A module (script or stylesheet) the graph checks look at; type declarations are not. */
export const isModule = (file) => MODULE.test(file) && !file.endsWith('.d.ts');

/** Every import specifier of a script (static, re-export, side-effect, dynamic) or stylesheet. */
export function importSpecs(file, text) {
  if (file.endsWith('.css')) return [...stripCssComments(text).matchAll(CSS_IMPORT)].map((match) => match[1]);
  const code = text.split('\n').filter((line) => !COMMENT_LINE.test(line)).join('\n');
  return [STATIC_IMPORT, SIDE_EFFECT_IMPORT, DYNAMIC_IMPORT].flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
}

/** The tree file a relative specifier points at (.ts/.tsx/index.ts tried, `.js` read as `.ts`), if any. */
export function resolveSpec(from, spec, files) {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const stem = base.replace(/\.js$/, '');
  return [base, `${stem}.ts`, `${stem}.tsx`, `${base}/index.ts`, `${base}/index.tsx`].find((candidate) => files.has(candidate));
}

/** Modules no entry reaches through relative imports (sorted). Targets not in the tree are skipped. */
export function orphanModules(files, entries = ENTRIES) {
  const seen = new Set();
  const stack = entries.filter((entry) => files.has(entry));
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importSpecs(file, files.get(file))) {
      const target = spec.startsWith('.') ? resolveSpec(file, spec, files) : undefined;
      if (target) stack.push(target);
    }
  }
  return [...files.keys()].filter((file) => isModule(file) && !seen.has(file)).sort();
}

/** Relative imports of a module under src that point at no module there (sorted by file). */
export function unresolvedImports(files) {
  const found = [];
  for (const [file, text] of files) {
    if (!isModule(file)) continue;
    for (const spec of importSpecs(file, text)) {
      if (!spec.startsWith('.') || !MODULE_SPEC.test(spec) || resolveSpec(file, spec, files)) continue;
      if (posix.normalize(posix.join(posix.dirname(file), spec)).startsWith('src/')) found.push({ file, spec });
    }
  }
  return found.sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
}

/** Stylesheets with nothing but comments and whitespace. */
export function emptyStylesheets(files) {
  return [...files].filter(([file, text]) => file.endsWith('.css') && !stripCssComments(text).trim()).map(([file]) => file).sort();
}

/** The comment block a file starts with (line or block comments, a shebang skipped). */
export function leadingComment(text) {
  const lines = [];
  let inBlock = false;
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (inBlock) { lines.push(line); if (trimmed.includes('*/')) inBlock = false; continue; }
    if (!lines.length && (!trimmed || trimmed.startsWith('#!'))) continue;
    if (trimmed.startsWith('//')) { lines.push(line); continue; }
    if (trimmed.startsWith('/*')) { lines.push(line); inBlock = !trimmed.slice(2).includes('*/'); continue; }
    break;
  }
  return lines.join('\n');
}

/** Modules whose leading comment has no "Owns:" line (db migrations are exempt). */
export function missingOwnsHeaders(files) {
  return [...files]
    .filter(([file, text]) => isModule(file) && !file.startsWith('src/runtime/db/migrations/') && !/\bOwns:/.test(leadingComment(text)))
    .map(([file]) => file).sort();
}

// SM10: shared code runs in every layer (node runtime, Electron main, the browser/phone page –
// e.g. the voice conversation's state machine), so it touches no platform global and starts no
// timer itself (both are injected). Comments and string literals do not count.
const codeOnly = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/\s.*$/gm, '')
  .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, "''");
const platformGlobal = /\b(?:process|Buffer|document|navigator|localStorage|sessionStorage|window)\s*\.|\brequire\s*\(|\b(?:setTimeout|setInterval|setImmediate)\s*\(/g;
// C7: the wf terminal client (src/runtime/wf-cli, its own bundle app/wf.mjs) is a plain RPC client:
// it imports src/shared and its own folder only (packages: node: builtins only), and nothing in
// src imports it.
const cliDir = 'src/runtime/wf-cli/';

/** Layer imports, file sizes, the wf-cli rules and shared code's platform globals. */
export function layerProblems(files) {
  const problems = [];
  const warnings = [];
  for (const [file, text] of files) {
    const layer = file.split('/')[1];
    if (!file.startsWith('src/') || !layers.includes(layer) || !/\.(?:ts|tsx|mjs)$/.test(file)) continue;
    const lines = text.split('\n').length;
    if (lines > 450) problems.push(`${file}: ${lines} lines (hard limit 450 – split it)`);
    else if (lines > 300) warnings.push(`${file}: ${lines} lines (soft limit 300)`);
    const inCli = file.startsWith(cliDir);
    for (const spec of importSpecs(file, text)) {
      if (!spec.startsWith('.')) {
        for (const pattern of forbiddenPackages[layer] ?? []) {
          if (pattern.test(spec)) problems.push(`${file}: imports package ${spec} (not allowed in ${layer})`);
        }
        if (inCli && !spec.startsWith('node:')) problems.push(`${file}: imports package ${spec} (wf-cli: node: builtins only)`);
        continue;
      }
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      const targetLayer = target.startsWith('src/') ? target.split('/')[1] : undefined;
      if (layers.includes(targetLayer) && !allowed[layer].includes(targetLayer)) problems.push(`${file}: imports ${spec} (${layer} → ${targetLayer} not allowed)`);
      if (inCli && !target.startsWith(cliDir) && !target.startsWith('src/shared/')) problems.push(`${file}: imports ${spec} (wf-cli may import shared and wf-cli only)`);
      if (!inCli && target.startsWith(cliDir)) problems.push(`${file}: imports ${spec} (wf-cli is a separate bundle; nothing imports it)`);
    }
    if (layer === 'shared') {
      for (const match of codeOnly(text).matchAll(platformGlobal)) {
        problems.push(`${file}: uses ${match[0].replace(/\s*[.(]$/, '')} (shared runs in every layer – inject it)`);
      }
    }
  }
  return { problems, warnings };
}

/** All checks over one tree: problems fail the run, warnings are printed. */
export function checkTree(files, options = {}) {
  const entries = options.entries ?? ENTRIES;
  const known = options.knownOrphans ?? KNOWN_ORPHANS;
  const { problems, warnings } = layerProblems(files);
  for (const entry of entries) if (!files.has(entry)) problems.push(`${entry}: entry not found (update ENTRIES in scripts/check-boundaries.mjs)`);
  const orphans = orphanModules(files, entries);
  for (const file of orphans) {
    if (known[file]) warnings.push(`${file}: imported by nothing (known: ${known[file]})`);
    else problems.push(`${file}: imported by nothing – import it where it is used, or add it to ENTRIES if something loads it by path`);
  }
  for (const file of Object.keys(known)) {
    if (files.has(file) && !orphans.includes(file)) warnings.push(`${file}: imported now – drop it from KNOWN_ORPHANS`);
  }
  for (const { file, spec } of unresolvedImports(files)) problems.push(`${file}: imports ${spec} (no such module under src)`);
  for (const file of emptyStylesheets(files)) problems.push(`${file}: no CSS rule outside comments (fill it or drop its @import)`);
  for (const file of missingOwnsHeaders(files)) problems.push(`${file}: no "Owns:" line in its header comment`);
  return { problems, warnings };
}

/** Reads every module and stylesheet under <root>/src into a tree keyed by posix path. */
export async function readTree(root) {
  const files = new Map();
  for (const entry of await readdir(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !MODULE.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    files.set(path.relative(root, full).split(path.sep).join('/'), await readFile(full, 'utf8'));
  }
  return files;
}

// Run as a script (node ≥ 24 sets import.meta.main); importing it for the tests checks nothing.
if (import.meta.main) {
  const { problems, warnings } = checkTree(await readTree(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')));
  for (const warning of warnings) console.warn('warn ', warning);
  if (problems.length) {
    for (const problem of problems) console.error('error', problem);
    process.exit(1);
  }
  console.log(`boundaries ok (${warnings.length} warnings)`);
}
