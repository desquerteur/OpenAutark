// D5 step wording (src/shared/text/step-label.ts): engine-native and our own tool calls as kind +
// verb + target like Codex ("Ran npm test", "Read …/chat/List.tsx", "Searched “todo”"), shell
// wrappers unwrapped (Windows PowerShell paths never reach the line), the engine's title or the
// journaled summary for anything else, and the reasoning headline. Root cause fixed: every step
// showed the raw tool name ("shell", "Bash") with one generic icon and no human line.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandText, isCommandText, reasoningHeadline, shortPath, stepLabel, stepText, toolDoing } from '../../../src/shared/text/step-label.ts';

const line = (name: string, args: unknown, hints = {}) => {
  const step = stepLabel(name, args, hints);
  return [step.kind, stepText(step)];
};

test('commands: Codex, Claude Code and ACP shells read "Ran <command>" without the shell wrapper', () => {
  assert.deepEqual(line('shell', { command: ['bash', '-lc', 'npm test'] }), ['command', 'Ran npm test']);
  assert.deepEqual(line('Bash', { command: 'git status', description: 'Show status' }), ['command', 'Ran git status']);
  assert.deepEqual(line('shell', { command: '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Get-ChildItem C:\\Users"' }),
    ['command', 'Ran Get-ChildItem C:\\Users'], 'the inner PowerShell command, never the System32 path');
  assert.deepEqual(line('shell.exec', { command: 'pnpm build' }), ['command', 'Ran pnpm build']);
  assert.equal(stepText(stepLabel('Bash', { command: 'npm test' }), true), 'Running npm test');
  assert.equal(commandText({ command: ['cmd.exe', '/c', 'dir'] }), 'dir');
  // Review fix: PowerShell 7's usual path has a space; cmd's /d /s flags.
  assert.equal(commandText({ command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -Command "npm test"' }), 'npm test');
  assert.equal(commandText({ command: 'C:\\Windows\\System32\\cmd.exe /d /s /c "dir /b"' }), 'dir /b');
  assert.equal(commandText({ cmd: 'ls -la' }), 'ls -la');
});

test('files: read, edit, write, search and list name their target', () => {
  assert.deepEqual(line('Read', { file_path: '/home/me/code/src/ui/chat/List.tsx' }), ['read', 'Read …/ui/chat/List.tsx']);
  assert.deepEqual(line('files.read', { path: 'notes.md' }), ['read', 'Read notes.md']);
  assert.deepEqual(line('apply_patch', { files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] }), ['edit', 'Edited a.ts, b.ts, c.ts +1']);
  assert.deepEqual(line('Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }), ['edit', 'Edited src/app.ts']);
  assert.deepEqual(line('Write', { file_path: 'out.txt', content: 'x' }), ['edit', 'Wrote out.txt']);
  assert.deepEqual(line('Grep', { pattern: 'TODO', path: 'src' }), ['search', 'Searched “TODO” in src']);
  assert.deepEqual(line('Glob', { pattern: '**/*.ts' }), ['search', 'Searched “**/*.ts”']);
  assert.deepEqual(line('LS', { path: '/tmp' }), ['list', 'Listed /tmp']);
  assert.equal(shortPath('a\\b\\c'), 'a/b/c');
});

test('web, plan, MCP and our own tools; the engine title or the summary when nothing better is known', () => {
  assert.deepEqual(line('web_search', { query: 'open invoices' }), ['web', 'Searched the web “open invoices”']);
  assert.deepEqual(line('WebFetch', { url: 'https://www.example.com/docs/' }), ['web', 'Opened example.com/docs']);
  assert.deepEqual(line('TodoWrite', { todos: [] }), ['plan', 'Updated the plan']);
  assert.deepEqual(line('github.create_issue', { title: 'x' }, { own: true }), ['mcp', 'Github create issue']);
  assert.deepEqual(line('mcp__linear__list_issues', {}, { own: true }), ['mcp', 'linear · list issues']);
  assert.deepEqual(line('chat.send', { text: 'hi' }, { summary: 'Send a message to #team' }), ['chat', 'Send a message to #team']);
  assert.deepEqual(line('tasks.create', { title: 'Ship it' }), ['task', 'Tasks create: Ship it']);
  assert.deepEqual(line('edit_file', {}, { own: true, title: 'Edit config.yaml' }), ['edit', 'Edit config.yaml'], 'an ACP title when the args name no file');
  assert.deepEqual(line('weird_tool', {}, { own: true, title: 'Doing a weird thing' }), ['tool', 'Doing a weird thing']);
  assert.deepEqual(line('weird_tool', {}), ['tool', 'Weird tool']);
  assert.deepEqual(line('', undefined), ['tool', 'Tool']);
});

test('reasoning headline: the latest **Title** line, else the first sentence (at most 80 characters)', () => {
  assert.equal(reasoningHeadline('**Planning the search**\n\nLooking around.\n\n**Checking results**\n\nAll good.'), 'Checking results');
  assert.equal(reasoningHeadline('I should read the brief first. Then decide.'), 'I should read the brief first');
  assert.equal(reasoningHeadline('No full stop here'), 'No full stop here');
  assert.equal(reasoningHeadline(`${'word '.repeat(40)}`).length <= 80, true);
  assert.equal(reasoningHeadline('   '), '');
});

// C3 fix: a call that names no target reads in the tool's own words, in both tenses, from the same table that
// turns an engine's bare live note into what the agent does (lib/format.ts workNote) – the run line and the
// chat header say the same ("Showing a page", never "Browser show"); only a real command line is code.
test('no target: the tool\'s own words in both tenses, one table with the live note; only a real command is code', () => {
  const show = stepLabel('browser.show', {});
  assert.equal(stepText(show, true), 'Showing a page');
  assert.equal(stepText(show), 'Showed a page');
  assert.equal(stepText(stepLabel('browser.click', {}), true), 'Using the browser');
  assert.equal(stepText(stepLabel('browser.navigate', {}), true), 'Opening a page');
  assert.equal(stepText(stepLabel('read_file', {}), true), 'Reading a file');
  assert.equal(stepText(stepLabel('web_search', {}), true), 'Searching the web');
  assert.equal(stepText(stepLabel('TodoWrite', {}), true), 'Updating the plan');
  const bare = stepLabel('bash', {});
  assert.deepEqual([stepText(bare), stepText(bare, true), isCommandText(bare)], ['Ran a command', 'Running a command', false]);
  assert.equal(isCommandText(stepLabel('bash', { command: 'npm test' })), true);
  assert.equal(isCommandText(stepLabel('bash', {}, { title: 'Run the tests' })), false, 'an engine title is words, not code');
  assert.equal(stepText(stepLabel('bash', {}, { title: 'Run the tests' })), 'Run the tests');
  for (const name of ['bash', 'browser.show', 'Browser show', 'browser.click', 'read_file', 'apply_patch', 'web_search']) {
    assert.equal(toolDoing(name), stepText(stepLabel(name.replace(' ', '.'), {}), true).toLowerCase(), name);
  }
  assert.equal(toolDoing('cutting intro'), undefined);
});
