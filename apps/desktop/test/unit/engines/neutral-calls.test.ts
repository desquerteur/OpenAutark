// B-049 neutral mapping (owner, 29.10.: after an engine switch the other engine sees the earlier tool work as if it
// had done it itself) – every row of the table both ways: Claude Bash/PowerShell and Codex shell ↔ Codex exec_command /
// Claude Bash or PowerShell, Claude Read/Grep/Glob → our files.read/files.search, edits as notes with their diff or
// content, Claude's own tools verbatim back into Claude Code, and the cases that stay notes (other origin, cut
// arguments, a tool the target lacks, an unknown tool). Command lines are real Codex 0.165 commandExecution lines.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_NATIVE, codexShell, globSearch, mapNativeCall, neutralOf, posixQuote, shellWords, type MapTarget,
} from '../../../src/runtime/engines/neutral-calls.ts';
import { coreTools } from '../../../src/runtime/engines/claude/lean.ts';

const FILES = new Set(['files.read', 'files.search', 'tasks.create']);
const codex = (platform = 'win32', offered: ReadonlySet<string> = FILES): MapTarget => ({ engine: 'codex', offered, native: CODEX_NATIVE, platform });
const claude = (platform: NodeJS.Platform = 'win32', offered: ReadonlySet<string> = FILES): MapTarget => ({ engine: 'claude', offered, native: new Set(coreTools(platform)), platform });

const PS_LINE = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '$ErrorActionPreference='"'Stop'; (Invoke-WebRequest -UseBasicParsing -Uri 'https://example.com/sitemap.xml').Content"`;
const PS_SCRIPT = `$ErrorActionPreference='Stop'; (Invoke-WebRequest -UseBasicParsing -Uri 'https://example.com/sitemap.xml').Content`;
const PS_NODE = String.raw`"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "node .\\probe.mjs"`;

test('neutral calls: Codex command lines read back into the script and its shell (POSIX quoting as Codex joins argv)', () => {
  assert.deepEqual(shellWords(PS_LINE), [String.raw`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`, '-Command', PS_SCRIPT]);
  assert.deepEqual(codexShell(PS_LINE), { kind: 'shell', shell: 'powershell', command: PS_SCRIPT, line: PS_LINE });
  assert.deepEqual(codexShell(PS_NODE), { kind: 'shell', shell: 'powershell', command: String.raw`node .\probe.mjs`, line: PS_NODE });
  assert.deepEqual(codexShell(`/bin/bash -lc 'npm test -- --grep "a b"'`), { kind: 'shell', shell: 'bash', command: 'npm test -- --grep "a b"', line: `/bin/bash -lc 'npm test -- --grep "a b"'` });
  assert.deepEqual(codexShell('git status'), { kind: 'shell', shell: 'direct', command: 'git status', line: 'git status' });
  assert.deepEqual(codexShell(['pwsh', '-NoProfile', '-Command', "Get-Item 'a b'"]), { kind: 'shell', shell: 'powershell', command: "Get-Item 'a b'", line: `pwsh -NoProfile -Command 'Get-Item '\\''a b'\\'''` });
  assert.equal(shellWords(`echo 'open`), undefined, 'an open quote is no command line');
  assert.deepEqual(codexShell(`echo 'open`), { kind: 'shell', shell: 'direct', command: `echo 'open`, line: `echo 'open` });
  assert.equal(codexShell(''), undefined);
  assert.equal(posixQuote('plain/path.txt'), 'plain/path.txt');
  assert.deepEqual(shellWords(`powershell -Command ${posixQuote("Write-Output 'x'")}`), ['powershell', '-Command', "Write-Output 'x'"]);
});

test('neutral calls: a shell call becomes Codex\'s own exec_command – the shell named only when it is not the platform default', () => {
  const bash = { name: 'Bash', args: { command: 'npm test', description: 'Run tests' } };
  assert.deepEqual(mapNativeCall(bash, 'claude', codex('win32')), { as: 'native', name: 'exec_command', args: { cmd: 'npm test', shell: 'bash' } });
  assert.deepEqual(mapNativeCall(bash, 'claude', codex('linux')), { as: 'native', name: 'exec_command', args: { cmd: 'npm test' } });
  const ps = { name: 'PowerShell', args: { command: 'Get-ChildItem' } };
  assert.deepEqual(mapNativeCall(ps, 'claude', codex('win32')), { as: 'native', name: 'exec_command', args: { cmd: 'Get-ChildItem' } });
  assert.deepEqual(mapNativeCall(ps, 'claude', codex('linux')), { as: 'native', name: 'exec_command', args: { cmd: 'Get-ChildItem', shell: 'powershell' } });
  // Codex's own commandExecution back into Codex: the script it wrote, not the wrapper line.
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: PS_LINE, cwd: 'C:\\work' } }, 'codex', codex('win32')), { as: 'native', name: 'exec_command', args: { cmd: PS_SCRIPT } });
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: `/bin/bash -lc 'ls -la'` } }, 'codex', codex('linux')), { as: 'native', name: 'exec_command', args: { cmd: 'ls -la' } });
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: 'git status' } }, undefined, codex('win32')), { as: 'native', name: 'exec_command', args: { cmd: 'git status' } });
  assert.deepEqual(mapNativeCall(bash, 'claude', { ...codex(), native: new Set() }), { as: 'note' }, 'no exec_command in the thread: a note');
});

test('neutral calls: a Codex shell call becomes Claude Code\'s Bash, or PowerShell on Windows for a PowerShell script', () => {
  const ps = { name: 'shell', args: { command: PS_LINE } };
  assert.deepEqual(mapNativeCall(ps, 'codex', claude('win32')), { as: 'native', name: 'PowerShell', args: { command: PS_SCRIPT } });
  assert.deepEqual(mapNativeCall(ps, 'codex', claude('linux')), { as: 'native', name: 'Bash', args: { command: PS_LINE } }, 'no PowerShell tool: the full line runs it from Bash');
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: `/bin/bash -lc 'npm test'` } }, 'codex', claude('linux')), { as: 'native', name: 'Bash', args: { command: 'npm test' } });
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: 'git status' } }, 'codex', claude('win32')), { as: 'native', name: 'Bash', args: { command: 'git status' } });
  assert.deepEqual(mapNativeCall(ps, 'codex', { ...claude(), native: new Set() }), { as: 'note' });
});

test('neutral calls: Claude Read/Grep/Glob become our files.read/files.search on Codex; a note when the thread lacks them', () => {
  assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path: 'C:\\work\\a.ts', offset: 40, limit: 20 } }, 'claude', codex()),
    { as: 'hub', name: 'files.read', args: { path: 'C:\\work\\a.ts', fromLine: 40, lines: 20 } });
  assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path: '/w/a.ts', offset: 0 } }, 'claude', codex()), { as: 'hub', name: 'files.read', args: { path: '/w/a.ts' } });
  assert.deepEqual(mapNativeCall({ name: 'Grep', args: { pattern: 'TODO', path: 'src', output_mode: 'content' } }, 'claude', codex()),
    { as: 'hub', name: 'files.search', args: { query: 'TODO', path: 'src', content: true } });
  assert.deepEqual(mapNativeCall({ name: 'Glob', args: { pattern: 'src/**/*.ts', path: '/repo/' } }, 'claude', codex()),
    { as: 'hub', name: 'files.search', args: { query: '*.ts', path: '/repo/src', content: false } });
  assert.deepEqual(globSearch('**/*.md', undefined), { kind: 'search', query: '*.md', content: false });
  assert.deepEqual(globSearch('C:\\repo\\docs\\*.md', 'D:\\other'), { kind: 'search', query: '*.md', path: 'C:/repo/docs', content: false });
  assert.equal(globSearch('src/*.{ts,tsx}', undefined), undefined, 'braces are beyond files.search');
  assert.deepEqual(mapNativeCall({ name: 'Glob', args: { pattern: '*.{ts,tsx}' } }, 'claude', codex()), { as: 'note' });
  assert.deepEqual(mapNativeCall({ name: 'Grep', args: { pattern: 'x'.repeat(201) } }, 'claude', codex()), { as: 'note' }, 'beyond the query bound');
  assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path: '/w/a.ts' } }, 'claude', codex('win32', new Set())), { as: 'note' });
});

test('neutral calls: edits stay notes with their diff or new content – Claude Edit/MultiEdit/Write on Codex, a Codex patch anywhere', () => {
  assert.deepEqual(mapNativeCall({ name: 'Edit', args: { file_path: 'a.ts', old_string: 'one\ntwo', new_string: 'three', replace_all: true } }, 'claude', codex()),
    { as: 'note', detail: '-one\n-two\n+three\n(every occurrence)' });
  assert.deepEqual(mapNativeCall({ name: 'MultiEdit', args: { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: '' }] } }, 'claude', codex()),
    { as: 'note', detail: '-a\n+b\n@@\n-c' });
  assert.deepEqual(mapNativeCall({ name: 'Write', args: { file_path: 'new.md', content: '# Title\nbody' } }, 'claude', codex()), { as: 'note', detail: '# Title\nbody' });
  const patch = { name: 'apply_patch', args: { files: ['a.ts', 'b.ts'] } };
  assert.deepEqual(neutralOf(patch, 'codex'), { kind: 'edit', path: 'a.ts, b.ts' });
  assert.deepEqual(mapNativeCall(patch, 'codex', claude()), { as: 'note' }, 'its diffs are in the output note');
  assert.deepEqual(mapNativeCall(patch, 'codex', codex()), { as: 'note' }, 'no exact apply_patch input is kept');
  assert.deepEqual(mapNativeCall({ name: 'MultiEdit', args: { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }] } }, 'claude', claude()),
    { as: 'note', detail: '-a\n+b' }, 'MultiEdit is not in the lean core: a note');
});

test('neutral calls: Claude Code\'s own core tools go back into Claude Code verbatim; Read falls back to files.read without the native tool', () => {
  for (const name of ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'PowerShell']) {
    const args = { command: 'x', file_path: 'a', pattern: 'p', old_string: 'o', new_string: 'n', content: 'c' };
    assert.deepEqual(mapNativeCall({ name, args }, 'claude', claude('win32')), { as: 'native', name, args });
  }
  assert.deepEqual(mapNativeCall({ name: 'PowerShell', args: { command: 'Get-Date' } }, 'claude', claude('linux')), { as: 'native', name: 'Bash', args: { command: 'powershell -Command Get-Date' } });
  assert.deepEqual(mapNativeCall({ name: 'PowerShell', args: { command: "Get-Item 'a b'" } }, 'claude', claude('linux')),
    { as: 'native', name: 'Bash', args: { command: `powershell -Command 'Get-Item '\\''a b'\\'''` } }, 'quoted so Bash passes the script whole');
  const noRead: MapTarget = { ...claude(), native: new Set(['Bash']) };
  assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path: '/w/a.ts' } }, 'claude', noRead), { as: 'hub', name: 'files.read', args: { path: '/w/a.ts' } });
});

test('neutral calls: other origins, cut arguments and unknown tools stay notes', () => {
  assert.deepEqual(mapNativeCall({ name: 'shell', args: { command: 'ls' } }, 'acp', codex()), { as: 'note' }, "an ACP CLI's shell is not Codex's");
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: { command: 'ls' } }, 'codex', claude()), { as: 'note' });
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: '{"command":"npm run build && npm te…' }, 'claude', codex()), { as: 'note' }, 'a cut journal preview');
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: '{"command":"npm test"}' }, 'claude', codex('linux')), { as: 'native', name: 'exec_command', args: { cmd: 'npm test' } }, 'a whole JSON preview reads');
  assert.deepEqual(mapNativeCall({ name: 'web_search', args: { query: 'x' } }, 'codex', claude()), { as: 'note' });
  assert.deepEqual(mapNativeCall({ name: 'WebFetch', args: { url: 'x' } }, 'claude', claude()), { as: 'note' }, 'not in the lean core');
  assert.deepEqual(mapNativeCall({ name: 'toString', args: {} }, undefined, codex()), { as: 'note' }, 'no prototype lookups');
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: { command: '' } }, 'claude', codex()), { as: 'note' });
});

// Review B-049: files.search finds a plain text (case-insensitive substring) and walks every folder below its path;
// files.read reads text. A call those tools cannot mean must not be shown as theirs – the agent would learn a
// capability they lack (a regex query that finds nothing, a filter that does not exist).
test('neutral calls: only calls the target tool can mean are mapped – regex/filtered Grep, narrowing Glob folders, media Reads, background shells stay notes', () => {
  const grep = (args: Record<string, unknown>) => mapNativeCall({ name: 'Grep', args }, 'claude', codex());
  assert.deepEqual(grep({ pattern: 'log.*Error', path: 'src' }), { as: 'note' }, 'a regular expression is no files.search query');
  assert.deepEqual(grep({ pattern: String.raw`function\s+\w+` }), { as: 'note' });
  assert.deepEqual(grep({ pattern: 'a|b' }), { as: 'note' });
  assert.deepEqual(grep({ pattern: 'TODO', glob: '*.ts' }), { as: 'note' }, 'a glob filter has no files.search counterpart');
  assert.deepEqual(grep({ pattern: 'TODO', type: 'ts' }), { as: 'note' });
  assert.deepEqual(grep({ pattern: 'TODO', multiline: true }), { as: 'note' });
  assert.deepEqual(grep({ pattern: String.raw`files\.read\(` }), { as: 'hub', name: 'files.search', args: { query: 'files.read(', content: true } }, 'escaped signs are plain text');
  assert.deepEqual(grep({ pattern: 'files.read', output_mode: 'content', '-n': true }), { as: 'hub', name: 'files.search', args: { query: 'files.read', content: true } });
  assert.equal(globSearch('src/**/test/*.ts', undefined), undefined, 'a literal folder below a wildcard narrows what files.search cannot');
  assert.equal(globSearch('src/*/index.ts', undefined), undefined, 'one folder level is not every level');
  assert.deepEqual(globSearch('src/**/**/*.ts', '/repo'), { kind: 'search', query: '*.ts', path: '/repo/src', content: false });
  for (const file_path of ['C:\\w\\shot.PNG', '/w/a.jpeg', '/w/doc.pdf', '/w/nb.ipynb']) {
    assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path } }, 'claude', codex()), { as: 'note' }, `${file_path}: files.read reads text only`);
  }
  assert.deepEqual(mapNativeCall({ name: 'Read', args: { file_path: '/w/a.txt', pages: '1-2' } }, 'claude', codex()), { as: 'note' });
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: { command: 'npm run dev', run_in_background: true } }, 'claude', codex()), { as: 'note' }, 'its output names a Claude-only shell id');
  assert.deepEqual(mapNativeCall({ name: 'Bash', args: { command: 'npm run dev', run_in_background: true } }, 'claude', claude()),
    { as: 'native', name: 'Bash', args: { command: 'npm run dev', run_in_background: true } }, 'back into Claude Code it stays exact');
});
