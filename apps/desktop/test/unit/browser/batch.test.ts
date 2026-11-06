// browser.batch and browser.find, and the change lists of browser.act: a batch runs its steps in order and
// stops at the first failure (done count + one change list), a step with submit makes the call an outside effect,
// stored secrets fill in a batch too; find returns only matching snapshot lines with refs; act answers with the lines
// that changed (the whole snapshot on a new page, with full, or when most of the page changed).

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { snapshotChanges } from '../../../src/runtime/browser/diff.ts';
import { findLines } from '../../../src/runtime/browser/inspect.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import { cleanupB055, scriptBrowser, textOf, toolCtx } from './b055-fakes.ts';

after(cleanupB055);

const tool = (tools: ToolDef[], name: string) => tools.find((entry) => entry.name === name)!;
const FORM = [
  '- heading "Sign up" [level=1] [ref=e1]',
  '- textbox "Name" [ref=e2]',
  '- textbox "Email" [ref=e3]',
  '- checkbox "Terms" [ref=e4]',
  '- button "Create account" [ref=e5]',
  '- link "Help" [ref=e6]',
].join('\n');

async function formPage() {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  await tool(tools, 'browser.open').run({ url: 'https://shop.test/signup' }, t.ctx);
  const page = rig.page();
  page.snapshot = FORM;
  await tool(tools, 'browser.snapshot').run({}, t.ctx);
  return { ...rig, tools, page, ...t };
}

test('batch: steps run in order with one change list; it stops at the first failing step', async () => {
  const { tools, page, ctx, browser } = await formPage();
  page.onAction = (selector, name) => {
    if (selector === 'aria-ref=e9') throw new Error('Timeout 10000ms exceeded. waiting for locator(\'aria-ref=e9\')');
    if (name === 'check') page.snapshot = FORM.replace('checkbox "Terms" [ref=e4]', 'checkbox "Terms" [checked] [ref=e4]');
  };
  const output = await tool(tools, 'browser.batch').run({ steps: [
    { action: 'fill', ref: 'e2', value: 'Ada' }, { action: 'fill', ref: 'e3', value: 'ada@example.com' }, { action: 'check', ref: 'e4' },
    { action: 'click', ref: 'e9' }, { action: 'click', ref: 'e5', submit: true },
  ] }, ctx);
  const text = textOf(output);
  assert.match(text, /^Batch: 3 of 5 steps done – step 4 \(click element e9\) failed: Could not act on element e9: it was not found/);
  assert.match(text, /\+ checkbox "Terms" \[checked\] \[ref=e4\]\n− checkbox "Terms" \[ref=e4\]/);
  assert.ok(!text.includes('link "Help"'), 'only what changed, not the whole snapshot');
  assert.deepEqual(page.actions.map((entry) => `${entry.name} ${entry.selector}`), ['fill aria-ref=e2', 'fill aria-ref=e3', 'check aria-ref=e4', 'click aria-ref=e9']);
  assert.deepEqual(page.moves, [], 'instant: the mouse jumps (no glide moves of ours)');
  assert.deepEqual(output.structured, { done: 3, total: 5, changed: true, url: 'https://shop.test/signup', tab: 't1', full: false });
  assert.equal(output.effect?.status, 'failed', 'the sending last step never ran');
  await browser.close();
});

test('batch: a step with submit makes the call an outside effect; stored secrets fill in a batch', async () => {
  const { tools, ctx, browser, page } = await formPage();
  const batch = tool(tools, 'browser.batch');
  const judged = batch.describe!({ steps: [{ action: 'fill', ref: 'e2', value: 'Ada' }, { action: 'click', ref: 'e5', submit: true }] }, ctx);
  assert.deepEqual([judged.external, judged.reversible], [true, false]);
  assert.match(judged.summary, /^Batch of 2: fill element e2; click element e5/);
  assert.equal(batch.describe!({ steps: [{ action: 'fill', ref: 'e3', value: 'secret://pw_1' }] }, ctx).summary, 'Batch of 1: fill element e3 (stored secret)');
  const out = await batch.run({ steps: [{ action: 'fill', ref: 'e3', value: 'secret://pw_1' }, { action: 'click', ref: 'e5', submit: true }] }, ctx);
  assert.equal(page.actions.find((action) => action.name === 'fill')?.value, 'value-of-pw_1');
  assert.ok(!textOf(out).includes('value-of-pw_1'));
  assert.deepEqual(out.effect, { status: 'unknown' }, 'the page did not change: may have happened');
  await browser.close();
});

test('find: only the matching snapshot lines with refs; the refs count for the next act', async () => {
  const { tools, ctx, browser } = await formPage();
  const text = textOf(await tool(tools, 'browser.find').run({ query: 'textbox' }, ctx));
  assert.match(text, /textbox "Name" \[ref=e2\]\ntextbox "Email" \[ref=e3\]/);
  assert.ok(!text.includes('button'), 'small output');
  assert.deepEqual(findLines(FORM, 'button create').lines, ['button "Create account" [ref=e5]']);
  assert.deepEqual(findLines(FORM, 'e6').lines, ['link "Help" [ref=e6]'], 'a ref finds its line');
  assert.match(textOf(await tool(tools, 'browser.find').run({ query: 'nothing here' }, ctx)), /Nothing on the page matches "nothing here"/);
  await browser.close();
});

test('act: a change list against the last snapshot; full and a new page give the whole snapshot; glide moves the mouse', async () => {
  const { tools, page, ctx, browser } = await formPage();
  page.boxes.set('aria-ref=e4', { x: 100, y: 200, width: 20, height: 20 });
  page.onAction = () => { page.snapshot = `${FORM}\n- dialog "Terms accepted" [ref=e7]`; };
  const text = textOf(await tool(tools, 'browser.act').run({ action: 'check', ref: 'e4' }, ctx));
  assert.match(text, /New dialog: dialog "Terms accepted" \[ref=e7\]/);
  assert.match(text, /Changes since my last snapshot of this tab \(\+1 −0 lines/);
  assert.ok(!text.includes('heading "Sign up"'));
  assert.ok(page.moves.length > 3, 'glide: real mouse moves on the way');
  assert.deepEqual(page.moves.at(-1), { x: 110, y: 210 }, 'it ends on the element\'s centre');
  page.onAction = () => {};
  const full = textOf(await tool(tools, 'browser.act').run({ action: 'hover', ref: 'e4', full: true, motion: 'instant' }, ctx));
  assert.match(full, /heading "Sign up"/, 'full: the whole snapshot');
  page.onAction = () => { page.urlValue = 'https://shop.test/welcome'; page.snapshot = '- heading "Welcome" [ref=e1]'; };
  const next = textOf(await tool(tools, 'browser.act').run({ action: 'click', ref: 'e5', submit: true, motion: 'instant' }, ctx));
  assert.match(next, /New page \(was https:\/\/shop\.test\/signup\):\n- heading "Welcome"/);
  await browser.close();
});

test('diff: unchanged, most changed and hash-only address changes', () => {
  const base = { urlBefore: 'https://a.test/x', url: 'https://a.test/x', title: 'A', titleBefore: 'A' };
  assert.match(snapshotChanges({ ...base, before: FORM, after: FORM }).text, /No change in the page since my last snapshot/);
  const most = snapshotChanges({ ...base, before: FORM, after: ['- a "1"', '- b "2"', '- c "3"', '- d "4"', '- e "5"', '- f "6"', '- g "7"'].join('\n') });
  assert.equal(most.full, true);
  assert.match(most.text, /^Most of the page changed:/);
  const hash = snapshotChanges({ ...base, url: 'https://a.test/x#part', before: FORM, after: `${FORM}\n- text: more`, title: 'B' });
  assert.equal(hash.full, false);
  assert.match(hash.text, /^Title now "B"\.\nAddress now https:\/\/a\.test\/x#part\./);
  assert.equal(snapshotChanges({ ...base, after: FORM }).full, true, 'no earlier snapshot: the whole one');
});
