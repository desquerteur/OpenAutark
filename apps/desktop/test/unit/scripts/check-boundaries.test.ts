// F08 – the structure guards of scripts/check-boundaries.mjs on small in-memory trees: orphan
// modules (reached from the entries through imports, re-exports, side-effect and dynamic imports
// and @import chains; known orphans warn, stale ones too; import-like text in strings and comments
// is no import; a missing target is reported, not followed), stylesheets without a rule, the
// "Owns:" line in the leading comment (migrations and type declarations exempt), and the layer,
// size, wf-cli and shared-globals rules it already had. On the real package: ENTRIES exist and
// cover every bundle entry of scripts/build.mjs and every src module a script imports.
// Owns: these assertions only. Never: writes files or runs the script as a process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkTree, emptyStylesheets, ENTRIES, importSpecs, KNOWN_ORPHANS, layerProblems, leadingComment, missingOwnsHeaders,
  orphanModules, readTree, resolveSpec, unresolvedImports,
} from '../../../scripts/check-boundaries.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HEADER = '// What this is.\n// Owns: it. Never: more.\n';
const tree = (files: Record<string, string>) => new Map(Object.entries(files));

function app(extra: Record<string, string> = {}) {
  return tree({
    'src/ui/main.tsx': `${HEADER}import { a } from './a.ts';\nimport './styles/index.css';\nconst lazy = () => import('./lazy.tsx');\n`,
    'src/ui/a.ts': `${HEADER}export { b } from './lib/b.ts';\nimport type { T } from '../shared/t.ts';\nimport { c } from './c';\n`,
    'src/ui/lib/b.ts': `${HEADER}export const b = 1;\n`,
    'src/ui/c.ts': `${HEADER}export const c = 1;\n`,
    'src/shared/t.ts': `${HEADER}export type T = 1;\n`,
    'src/ui/lazy.tsx': `${HEADER}export default 1;\n`,
    'src/ui/styles/index.css': '/* Entry.\n   Owns: order. Never: rules. */\n@import "./base.css";\n/* @import "./ghost.css"; */\n',
    'src/ui/styles/base.css': '/* Base. Owns: base. Never: areas. */\na { color: inherit; }\n',
    'src/ui/env.d.ts': 'declare const x: 1;\n',
    ...extra,
  });
}
const ENTRY = ['src/ui/main.tsx'];

test('orphans: whatever an entry reaches is used, the rest is reported', () => {
  assert.deepEqual(orphanModules(app(), ENTRY), []);
  const files = app({
    'src/ui/dead.ts': `${HEADER}export const dead = 1;\n`,
    'src/ui/styles/ghost.css': '/* Ghost. Owns: x. Never: y. */\nb { color: inherit; }\n',
    'src/ui/only-dead.ts': `${HEADER}import { dead } from './dead.ts';\n`,
  });
  // A commented-out @import does not count; a module imported only by an orphan is an orphan too.
  assert.deepEqual(orphanModules(files, ENTRY), ['src/ui/dead.ts', 'src/ui/only-dead.ts', 'src/ui/styles/ghost.css']);
  assert.equal(resolveSpec('src/ui/a.ts', './c', files), 'src/ui/c.ts');
  assert.equal(resolveSpec('src/ui/a.ts', '../shared/t.ts', files), 'src/shared/t.ts');
  assert.deepEqual(importSpecs('src/ui/main.tsx', files.get('src/ui/main.tsx')!).sort(), ['./a.ts', './lazy.tsx', './styles/index.css']);
});

test('imports are statements; a target that is missing or no module is reported, never followed', () => {
  const files = app({
    'src/ui/main.tsx': [
      `${HEADER}import { a } from './a.ts';\nimport './styles/index.css';\nconst lazy = () => import('./lazy.tsx');`,
      "import data from './data.json' with { type: 'json' };",
      "import { js } from './js.js';",
      "import { gone } from './gone.ts';",
      "// was: export { old } from './old.ts'",
      "/* import { older } from './older.ts'; */",
      " * import('./doc.tsx') in a doc comment",
      `const sample = "import x from './in-string.ts'";`,
      '',
    ].join('\n'),
    'src/ui/js.ts': `${HEADER}export const js = 1;\n`,
    'src/ui/old.ts': `${HEADER}export const old = 1;\n`,
    'src/ui/styles/index.css': '/* Entry. Owns: order. Never: rules. */\n@import "./base.css";\n@import "./missing.css";\n',
  });
  assert.deepEqual(importSpecs('src/ui/main.tsx', files.get('src/ui/main.tsx')!).sort(), ['./a.ts', './data.json', './gone.ts', './js.js', './lazy.tsx', './styles/index.css']);
  assert.equal(resolveSpec('src/ui/main.tsx', './js.js', files), 'src/ui/js.ts', 'a .js specifier means the .ts module');
  assert.equal(resolveSpec('src/ui/main.tsx', './gone.ts', files), undefined);
  // Only the commented-out import's module is unused; nothing crashes on a missing target.
  assert.deepEqual(orphanModules(files, ENTRY), ['src/ui/old.ts']);
  assert.deepEqual(unresolvedImports(files), [
    { file: 'src/ui/main.tsx', spec: './gone.ts' },
    { file: 'src/ui/styles/index.css', spec: './missing.css' },
  ]);
  const { problems } = checkTree(files, { entries: ENTRY, knownOrphans: {} });
  assert.deepEqual(problems, [
    'src/ui/old.ts: imported by nothing – import it where it is used, or add it to ENTRIES if something loads it by path',
    'src/ui/main.tsx: imports ./gone.ts (no such module under src)',
    'src/ui/styles/index.css: imports ./missing.css (no such module under src)',
  ]);
  // Imports that leave src (resources, package files) are not this check's business.
  assert.deepEqual(unresolvedImports(tree({ 'src/runtime/x.ts': `${HEADER}import p from '../../package.ts';\n` })), []);
});

test('checkTree: unknown orphans fail, known ones warn (and say when they are imported now), entries must exist', () => {
  const files = app({ 'src/ui/dead.ts': `${HEADER}export const dead = 1;\n`, 'src/ui/later.ts': `${HEADER}export const later = 1;\n` });
  const known = { 'src/ui/later.ts': 'wired by a later package', 'src/ui/c.ts': 'was unused' };
  const { problems, warnings } = checkTree(files, { entries: [...ENTRY, 'src/ui/gone.ts'], knownOrphans: known });
  assert.deepEqual(problems, [
    'src/ui/gone.ts: entry not found (update ENTRIES in scripts/check-boundaries.mjs)',
    'src/ui/dead.ts: imported by nothing – import it where it is used, or add it to ENTRIES if something loads it by path',
  ]);
  assert.deepEqual(warnings, [
    'src/ui/later.ts: imported by nothing (known: wired by a later package)',
    'src/ui/c.ts: imported now – drop it from KNOWN_ORPHANS',
  ]);
  assert.deepEqual(checkTree(app(), { entries: ENTRY, knownOrphans: {} }), { problems: [], warnings: [] });
});

test('empty stylesheets: comments and whitespace only', () => {
  const files = tree({
    'src/ui/styles/empty.css': '/* Header only.\n   Owns: nothing. Never: anything. */\n\n  \n',
    'src/ui/styles/blank.css': '',
    'src/ui/styles/index.css': '/* Owns: order. Never: rules. */\n@import "./empty.css";\n',
    'src/ui/styles/one.css': '/* Owns: x. Never: y. */\n.x { gap: 1px; }\n',
  });
  assert.deepEqual(emptyStylesheets(files), ['src/ui/styles/blank.css', 'src/ui/styles/empty.css']);
  const { problems } = checkTree(files, { entries: [], knownOrphans: {} });
  assert.ok(problems.includes('src/ui/styles/empty.css: no CSS rule outside comments (fill it or drop its @import)'));
});

test('Owns headers: the leading comment must name what the file owns', () => {
  const long = `${Array.from({ length: 34 }, (_, i) => `// rule ${i}`).join('\n')}\n// Owns: those rules. Never: more.\n\nexport {};\n`;
  const files = tree({
    'src/runtime/long.ts': long, // "Owns:" deep inside a long header is fine
    'src/main/entry.mjs': `#!/usr/bin/env node\n\n${HEADER}`,
    'src/ui/styles/x.css': '/* Area.\n   Owns: `x-*`. Never: y. */\n.x { gap: 1px; }\n',
    'src/runtime/late.ts': 'export const a = 1;\n// Owns: too late – not a header.\n',
    'src/shared/never-only.ts': '// Shapes things.\n// Never: owns anything.\nexport {};\n',
    'src/ui/styles/bare.css': '.y { gap: 1px; }\n',
    'src/runtime/db/migrations/030-x.ts': '// Migration 30: a column.\nexport const sql = ``;\n',
    'src/ui/env.d.ts': 'declare const x: 1;\n',
  });
  assert.deepEqual(missingOwnsHeaders(files), ['src/runtime/late.ts', 'src/shared/never-only.ts', 'src/ui/styles/bare.css']);
  assert.equal(leadingComment('\n\n/* a\n b */\n// c\ncode\n// d'), '/* a\n b */\n// c');
  assert.equal(leadingComment('/* one line */ \nx'), '/* one line */ ');
});

test('layer, size, wf-cli and shared-global rules still hold', () => {
  const lines = (n: number) => `${HEADER}${'\n'.repeat(n - 3)}`;
  const { problems, warnings } = layerProblems(tree({
    'src/ui/x.ts': `${HEADER}import { a } from '../runtime/a.ts';\nimport 'electron';\n`,
    'src/runtime/y.ts': `${HEADER}import { app } from 'electron';\nimport { run } from './wf-cli/run.ts';\n`,
    'src/runtime/wf-cli/z.ts': `${HEADER}import { a } from '../a.ts';\nimport ws from 'ws';\n`,
    'src/shared/s.ts': `${HEADER}// setTimeout( in a comment is fine\nconst t = 'process.env';\nsetTimeout(() => {}, 1);\n`,
    'src/main/big.ts': lines(451),
    'src/main/mid.ts': lines(301),
    'src/main/ok.ts': `${HEADER}import { s } from '../shared/s.ts';\nimport { app } from 'electron';\n`,
  }));
  assert.deepEqual(problems, [
    'src/ui/x.ts: imports ../runtime/a.ts (ui → runtime not allowed)',
    'src/ui/x.ts: imports package electron (not allowed in ui)',
    'src/runtime/y.ts: imports package electron (not allowed in runtime)',
    'src/runtime/y.ts: imports ./wf-cli/run.ts (wf-cli is a separate bundle; nothing imports it)',
    'src/runtime/wf-cli/z.ts: imports ../a.ts (wf-cli may import shared and wf-cli only)',
    'src/runtime/wf-cli/z.ts: imports package ws (wf-cli: node: builtins only)',
    'src/shared/s.ts: uses setTimeout (shared runs in every layer – inject it)',
    'src/main/big.ts: 451 lines (hard limit 450 – split it)',
  ]);
  assert.deepEqual(warnings, ['src/main/mid.ts: 301 lines (soft limit 300)']);
});

test('the real package: ENTRIES exist and cover every bundle entry and every src module a script imports', async () => {
  const files = await readTree(root);
  assert.ok(files.has('src/ui/styles/index.css') && files.has('src/runtime/tools/builtin/ui.ts'), 'posix keys for scripts and stylesheets');
  for (const entry of ENTRIES) assert.ok(files.has(entry), `${entry} is listed in ENTRIES but missing`);
  for (const file of Object.keys(KNOWN_ORPHANS)) assert.ok(files.has(file), `${file} is a known orphan that no longer exists`);
  assert.deepEqual(unresolvedImports(files), [], 'every relative import of src points at a module there');
  const build = readFileSync(path.join(root, 'scripts', 'build.mjs'), 'utf8');
  const entryPoints = [...build.matchAll(/entryPoints:\s*[[{]([^\]}]*)[\]}]/g)].flatMap((match) => [...match[1].matchAll(/'(src\/[^']+)'/g)].map((m) => m[1]));
  assert.ok(entryPoints.length >= 9, `found only ${entryPoints.join(', ')}`);
  const scripts = readdirSync(path.join(root, 'scripts')).filter((name) => name.endsWith('.mjs'));
  const fromScripts = scripts.flatMap((name) => importSpecs(name, readFileSync(path.join(root, 'scripts', name), 'utf8')))
    .filter((spec) => spec.startsWith('../src/')).map((spec) => spec.slice(3));
  for (const file of [...entryPoints, ...fromScripts]) assert.ok(ENTRIES.includes(file), `${file} is loaded by scripts/ but not in ENTRIES`);
});
