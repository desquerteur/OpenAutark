// CI workflow paths (SM12): every script a GitHub workflow step runs exists where the step runs it
// (step working-directory, else the job's or the workflow's defaults), every `npm run <name>` is a
// script of that folder's package.json, the unit tests run once per job (`npm run check` already
// runs them), and the npm cache key file exists. The workflows are read from `.github/workflows`
// and from `openautark/.github/workflows` (the public repository's own, which the open-source
// snapshot merges into its `.github`), so the same test runs in this tree and in the public one.
// A workflow that never checks out the repository runs no file of this tree – it builds from a
// compiled payload downloaded from a release draft, or reads a pull request through the API – so
// its paths and npm scripts are not checked here.
// Owns: these assertions and a small YAML-subset reader (maps, lists, block scalars) for the
// workflow files. Never: runs a workflow step or any of its commands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const repo = path.resolve(desktop, '..', '..');
const folders = [path.join(repo, '.github', 'workflows'), path.join(repo, 'openautark', '.github', 'workflows')];
/** Every workflow file as { name, full }; the name keeps its folder when it is not the repository's own `.github`. */
const files = folders.filter((folder) => existsSync(folder)).flatMap((folder) => readdirSync(folder)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name: folder === folders[0] ? name : `openautark/${name}`, full: path.join(folder, name) })))
  .sort((a, b) => a.name.localeCompare(b.name));
const workflowOf = (file: { full: string }) => readYaml(readFileSync(file.full, 'utf8'));

type Yaml = string | Yaml[] | { [key: string]: Yaml };
type YamlMap = { [key: string]: Yaml };

const indentOf = (line: string) => line.length - line.trimStart().length;
const KEY = /^("[^"]*"|'[^']*'|[^\s"'#][^:#]*?):(?:\s+|$)/;

function scalar(text: string): string {
  const bare = text.replace(/(^|\s)#.*$/, '').trim();
  return /^(["']).*\1$/.test(bare) ? bare.slice(1, -1) : bare;
}

/** Reads the YAML subset GitHub workflows use here: block maps, block lists, |/> scalars. */
function readYaml(text: string): Yaml {
  const lines = text.split(/\r?\n/);
  let i = 0;
  const skip = () => { while (i < lines.length && (!lines[i].trim() || lines[i].trim().startsWith('#'))) i++; };
  const isItem = (line: string) => /^-(\s|$)/.test(line.trim());

  function node(min: number): Yaml {
    skip();
    if (i >= lines.length || indentOf(lines[i]) < min) return '';
    return isItem(lines[i]) ? list(indentOf(lines[i])) : map(indentOf(lines[i]));
  }

  function blockScalar(parent: number): string {
    const body: string[] = [];
    while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > parent)) body.push(lines[i++]);
    const cut = Math.min(...body.filter((line) => line.trim()).map(indentOf));
    return body.map((line) => line.slice(Math.min(cut, line.length))).join('\n').trimEnd();
  }

  function value(rest: string, indent: number): Yaml {
    if (/^[|>][-+]?$/.test(rest)) return blockScalar(indent);
    if (rest && !rest.startsWith('#')) return scalar(rest);
    skip();
    if (i < lines.length && indentOf(lines[i]) === indent && isItem(lines[i])) return list(indent); // "key:\n- item"
    return node(indent + 1);
  }

  function map(indent: number): YamlMap {
    const out: YamlMap = {};
    for (skip(); i < lines.length && indentOf(lines[i]) === indent && !isItem(lines[i]); skip()) {
      const text = lines[i].trim();
      const match = KEY.exec(text);
      if (!match) throw new Error(`line ${i + 1}: expected "key: value", got ${JSON.stringify(text)}`);
      i++;
      out[scalar(match[1])] = value(text.slice(match[0].length).trim(), indent);
    }
    return out;
  }

  function list(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (skip(); i < lines.length && indentOf(lines[i]) === indent && isItem(lines[i]); skip()) {
      const after = lines[i].trim().slice(1).trimStart();
      if (!after) { i++; out.push(node(indent + 1)); continue; }
      if (!KEY.test(after)) { i++; out.push(scalar(after)); continue; }
      const column = lines[i].length - after.length; // "- key: v" → a map whose keys start here
      lines[i] = ' '.repeat(column) + after;
      out.push(map(column));
    }
    return out;
  }

  return node(0);
}

const asMap = (value: Yaml | undefined): YamlMap => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const asList = (value: Yaml | undefined): Yaml[] => (Array.isArray(value) ? value : []);
const asText = (value: Yaml | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

interface RunStep { job: string; cwd: string; command: string; with: YamlMap }

/** Every step with `run:` and the folder it runs in (relative to the repository root). */
function runSteps(workflow: Yaml): RunStep[] {
  const root = asMap(workflow);
  const workflowCwd = asText(asMap(asMap(root.defaults).run)['working-directory']) ?? '.';
  const steps: RunStep[] = [];
  for (const [job, definition] of Object.entries(asMap(root.jobs))) {
    const jobCwd = asText(asMap(asMap(asMap(definition).defaults).run)['working-directory']) ?? workflowCwd;
    for (const item of asList(asMap(definition).steps)) {
      const step = asMap(item);
      const command = asText(step.run) ?? '';
      steps.push({ job, cwd: asText(step['working-directory']) ?? jobCwd, command, with: asMap(step.with) });
    }
  }
  return steps;
}

/** Whether a job of the workflow checks out this repository (otherwise no step runs a file of this tree). */
function checksOut(workflow: Yaml): boolean {
  return Object.values(asMap(asMap(workflow).jobs)).some((definition) =>
    asList(asMap(definition).steps).some((item) => /^actions\/checkout@/.test(asText(asMap(item).uses) ?? '')));
}

/** The workflows whose steps run files of this tree. */
const fromSource = () => files.filter((file) => checksOut(workflowOf(file)));

const SCRIPT_PATH =/(?<![\w$./-])((?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:py|mjs|cjs|js|ts|sh|ps1))(?![\w/-])/g;
const NPM = /\bnpm\s+(?:run(?:-script)?\s+([\w:.-]+)|(test|t)\b)/g;

/** Script files a command runs (paths with a folder, e.g. `python scripts/stage-build.py`). */
function scriptPaths(command: string): string[] {
  return [...command.matchAll(SCRIPT_PATH)].map((match) => match[1]);
}

/** npm scripts a command starts (`npm test` is the 'test' script). */
function npmScripts(command: string): string[] {
  return [...command.matchAll(NPM)].map((match) => match[1] ?? 'test');
}

function packageScripts(folder: string): Record<string, string> {
  const file = path.join(repo, folder, 'package.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {} : {};
}

/** How often a command runs the given npm script, following `npm run x` inside scripts. */
function runsOf(target: string, command: string, scripts: Record<string, string>, seen = new Set<string>()): number {
  let count = 0;
  for (const name of npmScripts(command)) {
    if (name === target) count++;
    else if (scripts[name] && !seen.has(name)) count += runsOf(target, scripts[name], scripts, new Set([...seen, name]));
  }
  return count;
}

test('the YAML reader understands the workflow shapes used here', () => {
  const doc = asMap(readYaml([
    'jobs:', '  a:', '    defaults:', '      run:', '        working-directory: apps/x', '    steps:',
    '      - uses: actions/checkout@abc # v4', '      - run: npm run check # comment', '      - name: Block',
    '        working-directory: other', '        run: |', '          python scripts/one.py', '', '          node ./tools/two.mjs --flag',
    '  b:', '    steps:', '    - run: "bash scripts/three.sh"',
  ].join('\n')));
  const steps = runSteps(doc);
  assert.deepEqual(steps.map((step) => [step.job, step.cwd, step.command]), [
    ['a', 'apps/x', ''], ['a', 'apps/x', 'npm run check'], ['a', 'other', 'python scripts/one.py\n\nnode ./tools/two.mjs --flag'], ['b', '.', 'bash scripts/three.sh'],
  ]);
  assert.deepEqual(scriptPaths(steps[2].command), ['scripts/one.py', './tools/two.mjs']);
  assert.deepEqual(scriptPaths('run ${{ github.workspace }}/x.py and dist/a b.exe'), [], 'expressions and non-scripts are ignored');
  assert.deepEqual(npmScripts('npm ci && npm run check && npm test && npm run package -- --win'), ['check', 'test', 'package']);
});

test('every workflow file exists and is read; one builds from the sources', { skip: files.length === 0 && 'no .github/workflows next to the app' }, () => {
  assert.ok(fromSource().some((file) => /(^|\/)(desktop|build)\.yml$/.test(file.name)), 'a workflow builds and checks the app from its sources');
  for (const file of files) assert.ok(runSteps(workflowOf(file)).length > 0, `${file.name} has steps`);
});

test('a workflow that never checks out the repository is not checked for source paths', () => {
  const step = (uses: string) => ['jobs:', '  a:', '    steps:', `      - uses: ${uses}`, '      - run: node scripts/from-payload.mjs'].join('\n');
  assert.equal(checksOut(readYaml(step('actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4'))), true);
  assert.equal(checksOut(readYaml(step('actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6'))), false);
});

test('every script path a workflow step runs exists in its working directory', { skip: files.length === 0 && 'no workflows' }, () => {
  const checked: string[] = [];
  for (const file of fromSource()) {
    for (const step of runSteps(workflowOf(file))) {
      for (const script of scriptPaths(step.command)) {
        const full = path.resolve(repo, step.cwd, script);
        assert.ok(existsSync(full), `${file.name} (${step.job}): ${script} does not exist in ${step.cwd}`);
        checked.push(path.relative(repo, full).replaceAll('\\', '/'));
      }
    }
  }
  if (files.some((file) => file.name === 'desktop.yml')) assert.ok(checked.includes('apps/desktop/scripts/stage-build.py'), 'the build storage script is among the checked paths');
});

test('npm scripts exist, the unit tests run once per job and the npm cache key file exists', { skip: files.length === 0 && 'no workflows' }, () => {
  for (const file of fromSource()) {
    const name = file.name;
    const steps = runSteps(workflowOf(file));
    const testRuns = new Map<string, number>();
    for (const step of steps) {
      const scripts = packageScripts(step.cwd);
      for (const script of npmScripts(step.command)) assert.ok(scripts[script], `${name} (${step.job}): npm script "${script}" is missing in ${step.cwd}/package.json`);
      testRuns.set(step.job, (testRuns.get(step.job) ?? 0) + runsOf('test', step.command, scripts));
      const cacheKey = asText(step.with['cache-dependency-path']);
      if (cacheKey) assert.ok(existsSync(path.join(repo, cacheKey)), `${name} (${step.job}): ${cacheKey} does not exist`);
    }
    for (const [job, count] of testRuns) assert.ok(count <= 1, `${name} (${job}): the unit tests run ${count} times`);
  }
});
