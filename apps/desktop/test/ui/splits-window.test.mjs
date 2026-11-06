// Electron window check of B-057 Splits (S18) with the fake engine in an isolated test profile. The Manager's home is a
// git repository in the workspace ('site'), so its chat turns work there and a part may get its own worktree. Three
// groups are made through the fake engine's scripted [[tool:agents.split …]] (the brackets of the parts' own directives
// are JSON unicode escapes, so only the part that gets the brief runs them – splitCall):
//   1. "Launch check" chat: 3 brief parts – two answer, #3 fails ([[fail]], retried once) → gathered;
//   2. "Site title" chat: #1 has its own worktree; its shell.exec (no approval any more – agents may do everything)
//      changes index.html there – the part ends done and its work is committed on its branch (stat "1 file …");
//      #2 answers → gathered;
//   3. "Launch check" chat: #1 hangs ([[hang:bash]] – running until stopped), #2 answers, #3 waits for #1 (after).
// Checked:
//   (a) chat: the parent's agents.split step "Split · 2 of 3 done" collapsed, opening/closing its rows on click (header,
//       message list, composer and the step line keep their boxes); a failed row opens its error; the running group's
//       ONE live block ("1 of 3 parts working", spinner / done / waiting slots); a part row opens its own steps;
//   (b) Team sidebar: the Manager row shows the running split count in its reserved cell; the caret opens reports and
//       split rows below the agent (split rows are not team rows); open/close moves nothing above;
//   (c) #/team/<agent>/split/<split>: title, status, error of the failed part, brief, answer of a done part, a running
//       part's start time, live model and Stop (title menu); the worktree part's page has no Merge / Discard cell (merging is the
//       agent's job, split_merge) and its branch holds the change; Stop keeps every fact row in place;
//       the open part's sidebar row stays in view;
//   (d) the composer's Ultra switch (owner 30.10.2026: suggested for the next message): on / off, every composer cell keeps
//       its box; a sent message carries meta.ultra and shows the marker, the cell is off again, no chat setting;
//   (e) light and dark at 1280×800, 640×480 and 390×844: no horizontal overflow of the main containers, no overlapping
//       or clipped text in the split elements, the composer's model chip keeps room for its words beside the Ultra cell;
//       no renderer errors.
// Run: npm run build && node --test test/ui/splits-window.test.mjs   SCREENSHOTS=<dir> keeps the screenshots.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { expectStable } from './lib/stable.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const exact = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
/** The agents.split directive; the parts' own [[…]] directives are JSON-escaped (only the part's turn may run them – the
 *  JSON itself never has "[[" or "]]" outside a string). */
const splitCall = (goal, parts) => `[[tool:agents.split ${JSON.stringify({ goal, parts }).split('[[').join('\\u005b\\u005b').split(']]').join('\\u005d\\u005d')}]]`;

/** The test's stand-in for an agent editing its own worktree: shell.exec runs in the workspace or the part's worktree
 *  (the command names the helper by its full path), so this finds the
 *  part's worktree by its branch (wf/split-<slug of the part's title, cut>-<id6>) and writes the title into its index.html. */
const EDIT_TITLE = [
  "import { execFileSync } from 'node:child_process';",
  "import { appendFileSync, existsSync, writeFileSync } from 'node:fs';",
  "import { fileURLToPath } from 'node:url';",
  "import path from 'node:path';",
  "const [slug, title] = process.argv.slice(2);",
  "const repo = existsSync('site') ? 'site' : '.'; // the workspace, or already a folder of the repository (the part's worktree)",
  "const log = (line) => appendFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'edit-title.log'), line + '\\n');",
  "log(JSON.stringify({ cwd: process.cwd(), slug, title }));",
  "for (let i = 0; i < 50; i++) {",
  "  const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });",
  "  const tree = out.split(/\\r?\\n\\r?\\n/).map((block) => ({ dir: /^worktree (.+)$/m.exec(block)?.[1], branch: /^branch refs\\/heads\\/(.+)$/m.exec(block)?.[1] }))",
  "    .find((entry) => entry.dir && entry.branch?.startsWith('wf/split-') && slug.startsWith(entry.branch.slice(9).replace(/-[a-z0-9]{6}$/, '')));",
  "  if (tree) { writeFileSync(path.join(tree.dir, 'index.html'), '<h1>' + title + '</h1>\\n'); log('wrote ' + tree.dir); console.log('wrote ' + title); process.exit(0); }",
  "  execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);",
  "}",
  "log('no worktree for ' + slug); console.log('no worktree for ' + slug); process.exit(1);",
].join('\n');

async function until(read, check, label, ms = 120_000) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (check(value)) return value;
    await sleep(400);
  }
  assert.fail(`${label} (last: ${JSON.stringify(value)?.slice(0, 600)})`);
}

/** Main containers wider than their box, and split elements whose texts overlap or are cut without an ellipsis. */
function layoutProblems() {
  const out = [];
  const shown = (el) => el.getClientRects().length > 0;
  const wide = (el, label) => { if (shown(el) && el.scrollWidth > el.clientWidth + 1) out.push(`${label} scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`); };
  wide(document.documentElement, 'html');
  for (const sel of ['.shell', '.mobile-shell', '.message-scroller', '.agent-scroll', '.team-nav', '.team-rows', '.team-splits']) for (const el of document.querySelectorAll(sel)) wide(el, sel);
  // Boxes that do not scroll: their children stay inside (scrollWidth would also count the phone's invisible 44 px hit
  // rings – mobile.css ::after – around the last button of a row); row lists may hang 4 px to the left, so their hover
  // background runs past the text that lines up (chat.css .live-steps, splits.css).
  for (const sel of ['.agent-column', '.split-rows', '.split-facts', '.split-live', '.composer', '.composer-actions']) {
    for (const el of document.querySelectorAll(sel)) {
      if (!shown(el)) continue;
      const box = el.getBoundingClientRect();
      for (const kid of el.children) {
        const r = kid.getBoundingClientRect();
        if (r.width && (r.right > box.right + 0.5 || r.left < box.left - 4.5)) out.push(`${kid.className || kid.tagName} sticks out of ${sel} (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)})`);
      }
    }
  }
  for (const head of document.querySelectorAll('.split-row-head, .team-split-row, .run-item.split-step > .run-item-head, .split-live > .message-author, .split-branch-line')) {
    if (!shown(head)) continue;
    const box = head.getBoundingClientRect();
    const kids = [...head.children].filter((kid) => shown(kid) && kid.getBoundingClientRect().width > 0);
    kids.forEach((kid, index) => {
      const r = kid.getBoundingClientRect();
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${kid.className} sticks out of ${head.className} (${Math.round(r.left)}–${Math.round(r.right)} in ${Math.round(box.left)}–${Math.round(box.right)})`);
      const next = kids[index + 1]?.getBoundingClientRect();
      if (next && next.top < r.bottom - 0.5 && r.right > next.left + 0.5) out.push(`${kid.className} overlaps ${kids[index + 1].className} in ${head.className}`);
    });
  }
  for (const el of document.querySelectorAll('.split-row-model, .split-row-time, .team-split-time, .team-split-count, .split-live .working-model, .split-page-name, .split-facts dd, .split-branch, .split-branch-cell, .run-item.split-step .run-item-target')) {
    if (shown(el) && el.scrollWidth > el.clientWidth + 1) out.push(`${el.className || el.tagName} cut: "${el.textContent?.trim()}" (${el.scrollWidth} > ${el.clientWidth})`);
  }
  return out;
}

test('splits: step line, live block, sidebar rows, split page, worktree merge and Ultra in the real window', { timeout: 600_000 }, async (t) => {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-splits-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  mkdirSync(shots, { recursive: true });
  const emptyConfig = path.join(profile, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' };
  const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
  const repo = path.join(profile, 'workspace', 'site');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.name', 'Person']);
  git(repo, ['config', 'user.email', 'person@example.invalid']);
  writeFileSync(path.join(repo, 'index.html'), '<h1>Old title</h1>\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'Initial commit']);
  writeFileSync(path.join(profile, 'workspace', 'edit-title.mjs'), EDIT_TITLE);

  const app = await electron.launch({
    executablePath: electronPath, args: [root], cwd: root, timeout: 60_000,
    env: { ...gitEnv, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  t.after(async () => {
    rpc?.close?.();
    await app.close().catch(() => undefined);
    if (!process.env.SCREENSHOTS) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 60_000 });
  const size = async (width, height) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => { const [win] = BrowserWindow.getAllWindows(); win.setMinimumSize(320, 480); win.setSize(w, h); }, [width, height]);
    await page.waitForTimeout(800);
  };
  const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
  const theme = (scheme) => page.emulateMedia({ colorScheme: scheme });
  const noProblems = async (where) => { const list = await page.evaluate(layoutProblems); assert.deepEqual(list, [], `layout at ${where}`); };
  const go = async (hash, ready) => { await page.evaluate((h) => { location.hash = h; }, hash); await page.locator(ready).first().waitFor({ timeout: 20_000 }); };
  await size(1280, 800);

  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  await rpc.call('agents.create', { name: 'Quill', role: 'Writer', managerId: manager.id });
  await rpc.call('agents.setHome', { agentId: manager.id, home: repo });
  const launch = await rpc.call('chats.create', { title: 'Launch check', agentIds: [manager.id] });
  const site = await rpc.call('chats.create', { title: 'Site title', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', 'org', `chat:${launch.id}`, `chat:${site.id}`, `runs:${manager.id}`] });
  const group = (goal, check, label, ms) => rpc.waitFor('split.upserted', (g) => g.goal === goal && check(g), ms ?? 180_000).catch(() => assert.fail(label));
  const send = (chat, body) => rpc.call('messages.send', { conversationId: chat.id, body });

  // 1. Two parts answer, #3 fails (it is retried once, then it counts as failed); the parent gathers the group.
  const G1 = 'Check the launch notes before Friday';
  await send(launch, `Please check these in parallel ${splitCall(G1, [
    { title: 'Read the release notes', brief: 'Read the release notes and report the marker release-notes-ok.', context: 'brief' },
    { title: 'Check the changelog links', brief: 'Open every changelog link and report the marker links-ok.', context: 'brief', effort: 'low' },
    { title: 'Verify the version numbers', brief: 'Check every version number against the tags.\n[[fail]]', context: 'brief' },
  ])}`);
  const g1 = await group(G1, (g) => g.status === 'gathered', 'group 1 is gathered');
  assert.deepEqual(g1.splits.map((s) => s.status), ['done', 'done', 'failed']);

  // 2. A worktree part: its command changes index.html in its own worktree; it ends done and commits on its branch.
  // A loaded PC can make the runtime give up on `git worktree add` ("took too long"): then the part fails and the
  // agent splits once more (a second group under the same agent – the sidebar count below follows the groups).
  const helper = path.join(profile, 'workspace', 'edit-title.mjs').split(path.sep).join('/');
  const edit = { command: `node "${helper}" update-the-site-title "New title"` };
  let G2 = 'Refresh the site title';
  let first;
  for (const again of [false, true]) {
    if (again) G2 = 'Refresh the site title, again';
    await send(site, `Split the site work ${splitCall(G2, [
      { title: 'Update the site title', brief: `Change the page title in index.html.\n[[tool:shell.exec ${JSON.stringify(edit)}]]`, context: 'brief', worktree: true },
      { title: 'List the pages', brief: 'List the pages of the site and report the marker pages-ok.', context: 'brief' },
    ])}`);
    const goal = G2;
    first = await until(async () => (await rpc.call('splits.list', { agentId: manager.id })).find((g) => g.goal === goal),
      (g) => g && ['done', 'failed', 'stopped', 'skipped'].includes(g.splits[0].status), 'the worktree part ends', 240_000);
    if (first.splits[0].status === 'done' || again || !/took too long/.test(first.splits[0].error ?? '')) break;
    t.diagnostic(`git was too slow for the worktree (${first.splits[0].error}); splitting once more`);
    await group(goal, (g) => g.status === 'gathered', 'the failed worktree group is gathered');
  }
  assert.equal(first.splits[0].status, 'done', `the worktree part is done (it ended ${first.splits[0].status}: ${first.splits[0].error})`);
  const g2 = await group(G2, (g) => g.status === 'gathered' && g.splits[0].branch?.stat, 'group 2 is gathered with its branch');
  assert.equal(g2.splits[0].status, 'done');
  const helperLog = () => { try { return readFileSync(path.join(profile, 'workspace', 'edit-title.log'), 'utf8'); } catch { return 'no helper log'; } };
  assert.match(g2.splits[0].branch.stat, /1 file/, `the part's command changed index.html (helper: ${helperLog()}; the part: ${JSON.stringify(g2.splits[0])})`);

  // 3. A running group: #1 hangs, #2 answers, #3 waits for #1.
  const G3 = 'Write the landing page';
  await send(launch, `Now the landing page ${splitCall(G3, [
    { title: 'Draft the landing copy', brief: 'Write the hero text and two variants.\n[[hang:bash]]', context: 'brief', effort: 'high' },
    { title: 'Collect the screenshots', brief: 'Collect the product screenshots and report the marker shots-ok.', context: 'brief' },
    { title: 'Review the draft', brief: 'Try to refute the draft of part #1.', context: 'brief', after: [1] },
  ])}`);
  const g3 = await group(G3, (g) => g.splits[0].status === 'running' && g.splits[1].status === 'done', 'group 3 runs #1 and finished #2');
  assert.match(g3.splits[2].status, /^(pending|queued)$/);

  // (a) The chat: the parent's step line, collapsed; it opens and closes its rows in place.
  const fixed = ['.chat-header', '.chat-header .chat-title-button', '.message-scroller', '.composer'];
  await go(`#/chat/${launch.id}`, '.message-scroller');
  const replies = await rpc.call('messages.list', { conversationId: launch.id, limit: 100 });
  const reply1 = replies.find((m) => m.runId === g1.parentRunId);
  assert.ok(reply1, 'the parent answered in the chat with the run that split');
  const msg = page.locator(`[data-message-id="${reply1.id}"]`);
  await msg.locator('.run-disclosure-toggle').click();
  const step = msg.locator('.run-item.split-step');
  await step.waitFor({ timeout: 15_000 });
  const stepHead = msg.locator('.run-item.split-step > .run-item-head');
  await page.waitForFunction((id) => document.querySelector(`[data-message-id="${id}"] .run-item.split-step .run-item-target`)?.textContent === '· 2 of 3 done', reply1.id, { timeout: 15_000 });
  assert.equal((await stepHead.locator('.run-item-verb').textContent())?.trim(), 'Split');
  assert.equal(await stepHead.getAttribute('aria-expanded'), 'false', 'collapsed by default');
  assert.equal(await step.locator('.split-row').count(), 0);
  await stepHead.scrollIntoViewIfNeeded();
  await shot('splits-01-chat-step-collapsed-light');
  const stepId = `[data-message-id="${reply1.id}"] .run-item.split-step > .run-item-head`;
  await expectStable(page, [...fixed, stepId], async () => { await stepHead.click(); await step.locator('.split-row').nth(2).waitFor({ timeout: 10_000 }); });
  assert.deepEqual((await step.locator('.split-row-title').allTextContents()).map((s) => s.trim()), ['#1 Read the release notes', '#2 Check the changelog links', '#3 Verify the version numbers']);
  assert.deepEqual(await step.locator('.split-row').evaluateAll((rows) => rows.map((row) => row.className.replace('split-row ', ''))), ['status-done', 'status-done', 'status-failed']);
  assert.match((await step.locator('.split-row').nth(1).locator('.split-row-model').textContent()) ?? '', /· Low$/, 'the asked effort in the model slot');
  const heads = await step.locator('.split-row-head').evaluateAll((list) => list.map((h) => Math.round(h.getBoundingClientRect().height)));
  assert.ok(heads.every((h) => h === 24), `fixed 24 px rows (${heads})`);
  await expectStable(page, [...fixed, stepId], async () => { await step.locator('.split-row-head').nth(2).click(); await step.locator('.split-row-error').waitFor({ timeout: 10_000 }); });
  assert.match((await step.locator('.split-row-error').textContent()) ?? '', /could not complete/i, 'the failed part shows its error');
  await noProblems('chat 1280×800');
  await shot('splits-02-chat-step-open-light');
  await theme('dark');
  await shot('splits-03-chat-step-open-dark');
  await theme('light');
  await expectStable(page, [...fixed, stepId], async () => { await stepHead.click(); await step.locator('.split-row').first().waitFor({ state: 'detached', timeout: 5_000 }); });

  // The running group: ONE live block, its slots: spinner, done, waiting; a row opens its own steps.
  const live = page.locator(`.working-message.split-live[data-group-id="${g3.id}"]`);
  await live.waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.working-message.split-live').count(), 1, 'one live block per running group');
  assert.equal((await live.locator('.working-model').textContent())?.trim(), '1 of 3 parts working');
  assert.deepEqual(await live.locator('.split-icon').evaluateAll((icons) => icons.map((i) => i.className.replace('split-icon ', ''))), ['running', 'done', 'waiting']);
  assert.equal(await live.locator('.split-icon.running .spinner').count(), 1);
  // The running part names the model it runs on (the live activity's – its run row gets the model only when it ends).
  await page.waitForFunction((sel) => /^\S.* · High$/.test(document.querySelector(`${sel} .split-row:nth-child(1) .split-row-model`)?.textContent ?? ''),
    `.working-message.split-live[data-group-id="${g3.id}"]`, { timeout: 10_000 });
  const models = (await live.locator('.split-row-model').allTextContents()).map((s) => s.trim());
  assert.equal(models[0].split(' · ')[0], models[1].split(' · ')[0], `the same model name in every row (${models.join(' | ')})`);
  await live.scrollIntoViewIfNeeded();
  const liveId = `.working-message.split-live[data-group-id="${g3.id}"]`;
  // The live block is the list's last entry and the list sticks to its end (MessageList.tsx): what opens there pushes
  // the block up by its height – the frame stays, and the opened row stays in view.
  await expectStable(page, fixed, async () => {
    await live.locator('.split-row-head').nth(1).click();
    await live.locator('.split-row-body .run-items').waitFor({ timeout: 15_000 });
  });
  const inView = await page.evaluate((sel) => {
    const head = document.querySelector(`${sel} .split-row:nth-child(2) > .split-row-head`).getBoundingClientRect();
    const list = document.querySelector('.message-scroller').getBoundingClientRect();
    return head.top >= list.top - 0.5 && head.bottom <= list.bottom + 0.5;
  }, liveId);
  assert.ok(inView, 'the opened part row stays in view');
  await noProblems('live block 1280×800');
  await shot('splits-04-chat-live-light');
  await theme('dark');
  await shot('splits-05-chat-live-dark');
  await theme('light');
  await live.locator('.split-row-head').nth(1).click();

  // (d) Ultra (owner 30.10.2026): suggested for the next message – the labelled switch beside the model chip, on and
  // off, every composer cell keeps its box; the sent message carries it (meta.ultra) and shows the marker, the switch is
  // off again, and the chat keeps no Ultra setting.
  const ultra = page.locator('.composer .ultra-switch');
  const pressed = (value) => page.waitForFunction((want) => document.querySelector('.composer .ultra-switch')?.getAttribute('aria-checked') === want, value);
  assert.equal(await ultra.getAttribute('aria-checked'), 'false');
  assert.equal(await ultra.getAttribute('title'), 'Suggest Ultra for this message');
  const cells = await page.locator('.composer-actions > *').count();
  const cellIds = Array.from({ length: cells }, (_, i) => `.composer-actions > :nth-child(${i + 1})`);
  await expectStable(page, [...fixed, ...cellIds], async () => { await ultra.click(); await pressed('true'); });
  assert.equal(await ultra.getAttribute('title'), 'Ultra suggested for this message');
  assert.equal((await ultra.textContent())?.trim(), 'Ultra', 'a labelled switch');
  await shot('splits-06-ultra-on-light');
  await theme('dark');
  await shot('splits-07-ultra-on-dark');
  await theme('light');
  await expectStable(page, [...fixed, ...cellIds], async () => { await ultra.click(); await pressed('false'); });
  await ultra.click();
  await pressed('true');
  const field = page.locator('.composer .composer-input');
  await field.fill('/silent Ultra check: compare the three drafts'); // silent: no agent turn starts in the middle of this test
  await field.press('Enter');
  await pressed('false'); // the next message starts without it
  const sent = (await until(() => rpc.call('messages.list', { conversationId: launch.id, limit: 30 }),
    (list) => list.some((message) => message.body === 'Ultra check: compare the three drafts'), 'the Ultra message is sent', 10_000))
    .find((message) => message.body === 'Ultra check: compare the three drafts');
  assert.equal(sent.meta.ultra, true, 'the message carries the suggestion');
  assert.equal(sent.silent, true);
  await page.locator(`[data-message-id="${sent.id}"] .ultra-marker`).waitFor({ timeout: 10_000 });
  assert.equal((await rpc.call('chats.get', { id: launch.id })).settings.ultra, undefined, 'no chat setting');
  await shot('splits-06b-ultra-sent-light');

  // (b) Team sidebar: the count in the reserved cell; the caret opens reports and split rows under the agent.
  await go(`#/team/${manager.id}`, '.team-nav .team-row');
  const row = page.locator('.team-nav .team-row:not(.person)', { has: page.locator('.row-title', { hasText: exact(manager.name) }) }).first();
  await row.locator('.team-split-count', { hasText: /^1$/ }).waitFor({ timeout: 15_000 });
  const caret = row.locator('.team-caret');
  assert.equal(await caret.getAttribute('aria-label'), `Show reports and splits of ${manager.name}`);
  // The rows above the Manager's (people first) and its own cells – marked for the measurement only.
  const above = await row.evaluate((agentRow) => {
    const rows = [...document.querySelectorAll('.team-nav .team-row')];
    const index = rows.indexOf(agentRow);
    rows.slice(0, index).forEach((other, i) => other.setAttribute('data-test-row', `above-${i}`));
    agentRow.setAttribute('data-test-row', 'agent');
    return index;
  });
  const agentSel = '[data-test-row="agent"]';
  const navFixed = ['.team-nav .team-space-title', ...Array.from({ length: above }, (_, i) => `[data-test-row="above-${i}"]`),
    agentSel, `${agentSel} .team-row-open`, `${agentSel} .agent-status-avatar`,`${agentSel} .team-split-count`, `${agentSel} .team-caret`];
  await expectStable(page, navFixed, async () => { await caret.click(); await page.locator('.team-splits .team-split-row').first().waitFor({ timeout: 10_000 }); });
  const splitRows = page.locator('.team-splits .team-split-row');
  const parts = (await rpc.call('splits.list', { agentId: manager.id })).slice(0, 4).reduce((sum, g) => sum + g.splits.length, 0);
  assert.equal(await splitRows.count(), parts, 'every part of its newest groups (at most 4)');
  assert.equal(await page.locator('.team-splits .team-row').count(), 0, 'split rows are not team rows');
  const order = await row.evaluate((agentRow) => {
    const box = agentRow.getBoundingClientRect();
    const reports = agentRow.nextElementSibling?.classList.contains('team-reports') ? agentRow.nextElementSibling : null;
    const splits = (reports ?? agentRow).nextElementSibling;
    const at = splits?.getBoundingClientRect();
    return { reports: Boolean(reports), splits: Boolean(splits?.classList.contains('team-splits')), below: Boolean(at && at.top >= box.bottom - 0.5),
      afterReports: Boolean(at && (!reports || at.top >= reports.getBoundingClientRect().bottom - 0.5)) };
  });
  assert.deepEqual(order, { reports: true, splits: true, below: true, afterReports: true }, 'split rows sit under the agent, after its reports');
  const newestInView = await page.evaluate(() => {
    const box = document.querySelector('.team-splits');
    const last = [...box.querySelectorAll('.team-split-row')].at(-1).getBoundingClientRect();
    const view = box.getBoundingClientRect();
    return last.top >= view.top - 0.5 && last.bottom <= view.bottom + 0.5;
  });
  assert.ok(newestInView, 'opened, the block shows its newest group (the running one)');
  await noProblems('team sidebar 1280×800');
  await shot('splits-08-team-sidebar-light');
  await theme('dark');
  await shot('splits-09-team-sidebar-dark');
  await theme('light');
  await expectStable(page, navFixed, async () => { await caret.click(); await page.locator('.team-splits').waitFor({ state: 'detached', timeout: 5_000 }); });
  await caret.click();
  await splitRows.first().waitFor({ timeout: 10_000 });

  // (c) The failed part's page: title, status, error, brief (opening it moves nothing above).
  const failed = g1.splits[2];
  await page.locator(`.team-split-row[title="${failed.title}"]`).click();
  await page.waitForFunction(([a, s]) => location.hash === `#/team/${a}/split/${s}`, [manager.id, failed.id], { timeout: 10_000 });
  await page.locator('.split-page-name').waitFor({ timeout: 15_000 });
  assert.equal((await page.locator('.split-header .frame-header-title').textContent())?.trim(), `${manager.name} · Part 3 of 3`);
  assert.equal((await page.locator('.split-page-name').textContent())?.trim(), '#3 Verify the version numbers');
  assert.match((await page.locator('.split-facts > div', { hasText: 'Status' }).locator('dd').textContent()) ?? '', /^Failed/);
  const fact = async (label) => ((await page.locator('.split-facts > div', { has: page.locator('dt', { hasText: exact(label) }) }).locator('dd').textContent()) ?? '').trim();
  assert.match(await fact('Error'), /could not complete/i, 'the failed part says why');
  assert.match(await fact('Model'), /\S/, 'no blank model fact');
  assert.match(await fact('Cost'), /\S/, 'no blank cost fact');
  assert.equal(await page.locator('.team-split-row.active').getAttribute('title'), failed.title, 'the open part is selected in the sidebar');
  assert.equal((await page.locator('.split-brief-first').textContent())?.trim(), 'Check every version number against the tags.');
  await expectStable(page, ['.split-header', '.split-page-title', '.split-facts', '.split-brief-toggle'], async () => { await page.locator('.split-brief-toggle').click(); await page.locator('.split-brief-text').waitFor(); });
  await noProblems('failed split page 1280×800');
  await shot('splits-10-split-failed-light');
  await theme('dark');
  await shot('splits-11-split-failed-dark');
  await theme('light');

  // A done part's page: its answer (kept internal) opens to the text.
  await page.locator(`.team-split-row[title="${g1.splits[0].title}"]`).click();
  await page.locator('.split-page-name', { hasText: '#1 Read the release notes' }).waitFor({ timeout: 15_000 });
  const answer = page.locator('.split-page-items .run-item.answer');
  await answer.waitFor({ timeout: 15_000 });
  await answer.locator('.run-item-head').click();
  assert.match((await answer.locator('.run-item-text').textContent()) ?? '', /release-notes-ok/);
  await shot('splits-12-split-answer-light');

  // The worktree part: its page opens; merging is the agent's job (no Merge / Discard cell); its branch holds the change
  // and the main checkout is untouched.
  const tree = g2.splits[0];
  await page.locator(`.team-split-row[title="${tree.title}"]`).click();
  await page.locator('.split-page-name', { hasText: '#1 Update the site title' }).waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: 'Merge', exact: true }).count(), 0, 'no Merge cell');
  assert.ok(tree.branch?.name, 'the part has its branch');
  assert.match(git(repo, ['show', `${tree.branch.name}:index.html`]).trim(), /<h1>New title<\/h1>/, "the part's work is committed on its branch");
  assert.equal(readFileSync(path.join(repo, 'index.html'), 'utf8').trim(), '<h1>Old title</h1>', 'the main checkout is untouched');
  await noProblems('worktree split page 1280×800');
  await shot('splits-13-split-worktree-light');
  await theme('dark');
  await shot('splits-14-split-worktree-dark');
  await theme('light');

  // The running part's page: Stop in its title menu (the same menu as a right-click on the page).
  const running = g3.splits[0];
  await go(`#/team/${manager.id}/split/${running.id}`, '.split-page-name');
  const titleMenu = page.locator('.split-header .title-menu');
  await titleMenu.click();
  await page.getByRole('menuitem', { name: 'Stop', exact: true }).waitFor({ timeout: 15_000 });
  await page.keyboard.press('Escape');
  assert.match((await page.locator('.split-facts > div', { hasText: 'Status' }).locator('dd').textContent()) ?? '', /^Running/);
  assert.match(await fact('Time'), /^Started \d{1,2}[:.]\d{2}/, 'a running part shows when it started (no clock that stands still)');
  assert.match(await fact('Model'), /^\S.* · High$/, 'and the model it runs on');
  assert.ok(await page.evaluate(() => {
    const row = document.querySelector('.team-splits .team-split-row.active')?.getBoundingClientRect();
    const view = document.querySelector('.team-splits').getBoundingClientRect();
    return Boolean(row && row.top >= view.top - 0.5 && row.bottom <= view.bottom + 0.5);
  }), 'the open part\'s sidebar row is in view after the page changed to it');
  await shot('splits-17-split-running-light');

  // (e) Smaller windows and the phone: the chat with the open step and the live block, the failed part's page.
  for (const [w, h, name] of [[640, 480, '640x480'], [390, 844, 'phone']]) {
    await size(w, h);
    await go(`#/chat/${launch.id}`, '.message-scroller');
    const small = page.locator(`[data-message-id="${reply1.id}"]`);
    await small.locator('.run-disclosure-toggle').waitFor({ timeout: 15_000 });
    if (await small.locator('.run-disclosure-toggle').getAttribute('aria-expanded') !== 'true') await small.locator('.run-disclosure-toggle').click();
    const smallHead = small.locator('.run-item.split-step > .run-item-head');
    await smallHead.waitFor({ timeout: 15_000 });
    if (await smallHead.getAttribute('aria-expanded') !== 'true') await smallHead.click();
    await small.locator('.split-row').nth(2).waitFor({ timeout: 10_000 });
    await small.locator('.run-item.split-step').scrollIntoViewIfNeeded();
    await noProblems(`chat step ${name}`);
    const chipWords = await page.locator('.composer .model-chip .chip-label').evaluate((el) => Math.round(el.getBoundingClientRect().width));
    assert.ok(chipWords >= 40, `with the Ultra cell the model chip keeps room for its words at ${name} (${chipWords} px)`);
    await shot(`splits-18-chat-step-${name}-light`);
    await page.locator(liveId).scrollIntoViewIfNeeded();
    await noProblems(`live block ${name}`);
    await shot(`splits-19-chat-live-${name}-light`);
    await theme('dark');
    await shot(`splits-20-chat-live-${name}-dark`);
    await theme('light');
    await go(`#/team/${manager.id}/split/${failed.id}`, '.split-page-name');
    await noProblems(`failed split page ${name}`);
    await shot(`splits-21-split-failed-${name}-light`);
    await theme('dark');
    await shot(`splits-22-split-failed-${name}-dark`);
    await theme('light');
  }
  await size(1280, 800);

  // Stop the running part from its title menu: the header and the facts keep their rows (the reason comes in as the
  // last one); #1 stopped, #3 never starts; the menu offers no Stop any more.
  await go(`#/team/${manager.id}/split/${running.id}`, '.split-header .title-menu');
  const factRows = Array.from({ length: await page.locator('.split-facts > div').count() }, (_, i) => `.split-facts > div:nth-child(${i + 1}) > dt`);
  await expectStable(page, ['.split-header', '.split-header .title-menu', '.split-page-title', ...factRows], async () => {
    await page.locator('.split-header .title-menu').click();
    await page.getByRole('menuitem', { name: 'Stop', exact: true }).click();
    await page.locator('.split-facts dd.split-fact-why').waitFor({ timeout: 15_000 });
  });
  await page.locator('.split-header .title-menu').click();
  await page.getByRole('menuitem', { name: 'Open', exact: true }).waitFor({ timeout: 5_000 });
  assert.equal(await page.getByRole('menuitem', { name: 'Stop', exact: true }).count(), 0, 'a stopped part has no Stop');
  await page.keyboard.press('Escape');
  assert.equal(await fact('Reason'), 'Stopped by the person.');
  const ended = await group(G3, (g) => g.splits.every((s) => ['done', 'failed', 'stopped', 'skipped'].includes(s.status)), 'group 3 ends after Stop', 30_000);
  assert.equal(ended.splits[0].status, 'stopped');
  assert.match(ended.splits[2].status, /^(stopped|skipped)$/);
  await shot('splits-23-split-stopped-light');

  t.diagnostic(`screenshots: ${shots}`);
  const relevant = errors.filter((entry) => !/Autofill|DevTools|Electron Security Warning/i.test(entry));
  assert.deepEqual(relevant, [], 'no renderer errors');
});
