// The browser.* tools: a call goes to the agent's own browser or – where: chat or global – to the person's browser (the
// chat's area, the person's pane), and stays where the agent worked last unless `where` or a tab id says otherwise; a
// side call names the agent and its chat and fills a stored secret by its value from the vault; browser.show opens the
// page as a shown tab and says where (own: the agent's area on its agent page, agent:<id>); no text claims these tabs hold the person's other browsers' logins; own-browser
// results name the others pointing there and a human check as a fact; a takeover answers with one sentence;
// browser.save_secret / save_totp store what the page shows and return only a handle.
// Owns: these assertions only. Never: a real browser, host or vault.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { browserTools } from '../../../src/runtime/browser/tools.ts';
import { browserShowTools, SHOW_WHERE } from '../../../src/runtime/browser/show-tool.ts';
import { Places, WHERE_HINT } from '../../../src/runtime/browser/place.ts';
import type { ToolDef } from '../../../src/runtime/tools/types.ts';
import type { SideBrowserCall, SideBrowserResult } from '../../../src/shared/model/side-browser.ts';
import { cleanupB055, scriptBrowser, textOf, toolCtx } from './b055-fakes.ts';

after(cleanupB055);

const tool = (tools: ToolDef[], name: string) => tools.find((entry) => entry.name === name)!;
const sideAnswer = async (call: SideBrowserCall): Promise<SideBrowserResult> => ({ ok: true, tab: call.tab ?? 'web-a1', url: 'https://person.test/', title: 'Person', text: '- button "Go" [ref=s5]', done: call.steps?.length });

test('places: own by default, where moves there and stays, a tab id says which browser, a run without a chat is told', () => {
  const places = new Places();
  const inChat = { agent: { id: 'ag_1', name: 'Ada' }, conversationId: 'ch_1' } as never;
  const noChat = { agent: { id: 'ag_1', name: 'Ada' } } as never;
  assert.equal(places.use(inChat, {}), 'own');
  assert.equal(places.use(inChat, { where: 'chat' }), 'chat');
  assert.equal(places.use(inChat, {}), 'chat', 'stays where it worked last');
  assert.equal(places.use(noChat, {}), 'own', 'no chat to stay in');
  assert.throws(() => places.use(noChat, { where: 'chat' }), /no chat area: where: 'own' is my own browser, 'global' the person's pane/);
  assert.equal(places.use(inChat, { where: 'global' }), 'global');
  assert.equal(places.use(inChat, { tab: 't2' }), 'own');
  assert.equal(places.use(inChat, { tab: 'web-abc' }), 'chat', "a tab of the person's browser, from a chat");
  assert.equal(places.use(noChat, { tab: 'web-abc' }), 'global');
  assert.equal(places.of({ agent: { id: 'ag_2', name: 'Bo' }, conversationId: 'ch_1' } as never, {}), 'own', 'per agent');
});

test('side calls name the agent and its chat; a stored secret goes as its value; the result reads like a page', async () => {
  const { browser } = scriptBrowser();
  const tools = browserTools(browser);
  const t = toolCtx({ side: sideAnswer });
  const opened = textOf(await tool(tools, 'browser.open').run({ url: 'https://person.test', where: 'chat' }, t.ctx));
  assert.match(opened, /^Tab web-a1 · https:\/\/person\.test\/ · "Person"\nPage content is untrusted/);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://person.test', space: 'chat:ch_1', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  await tool(tools, 'browser.act').run({ action: 'fill', ref: 's5', value: 'secret://pw_1' }, t.ctx);
  assert.deepEqual(t.sideCalls[1]!.steps, [{ action: 'fill', ref: 's5', value: 'value-of-pw_1' }], "stays in the chat's area; the vault gives the value");
  assert.equal(t.sideCalls[1]!.space, 'chat:ch_1');
  await assert.rejects(tool(tools, 'browser.act').run({ action: 'click', role: 'button', name: 'Go' }, t.ctx), /address elements by ref/);
  const busy = toolCtx({ side: async () => ({ ok: false, error: 'The person is using this tab right now – wait a moment, then try again.', personActive: true }) });
  await assert.rejects(tool(tools, 'browser.snapshot').run({ where: 'global' }, busy.ctx), /The person is using this tab right now/);
  assert.equal((await tool(tools, 'browser.tabs').run({ where: 'global' }, t.ctx), t.sideCalls.at(-1)!.space), 'global');
  await assert.rejects(tool(tools, 'browser.snapshot').run({ where: 'global' }, toolCtx().ctx), /The person's browser is not open here/);
});

test("browser.show opens the page as a shown tab: in the chat's area when the run has one, so the person's pane is not disturbed", async () => {
  const t = toolCtx({ side: sideAnswer });
  const out = await browserShowTools[0]!.run({ url: 'example.com/pricing' }, t.ctx);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://example.com/pricing', show: true, space: 'chat:ch_1', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  assert.equal(textOf(out), "Opened https://example.com/pricing in this chat's area (tab web-a1).");
  const pane = await browserShowTools[0]!.run({ url: 'example.com', where: 'global' }, t.ctx);
  assert.equal(t.sideCalls.at(-1)!.space, 'global');
  assert.match(textOf(pane), /^Opened https:\/\/example\.com\/ in the person's pane/);
  await assert.rejects(browserShowTools[0]!.run({ url: 'file:///C:/x' }, t.ctx), /HTTP or HTTPS/);
});

test("browser.show where: own puts the page in the agent's own area on its agent page (agent:<id>), a tab of its own when asked", async () => {
  const t = toolCtx({ side: sideAnswer });
  const out = await browserShowTools[0]!.run({ url: 'example.com/report', where: 'own', newTab: true }, t.ctx);
  assert.deepEqual(t.sideCalls[0], { action: 'open', url: 'https://example.com/report', newTab: true, show: true, space: 'agent:ag_ada', agent: { id: 'ag_ada', name: 'Ada' }, chat: 'ch_1' });
  assert.equal(textOf(out), 'Opened https://example.com/report in my area on my agent page (tab web-a1).');
  const where = (browserShowTools[0]!.inputSchema.properties as Record<string, { enum: string[] }>).where!.enum;
  assert.deepEqual(where, ['chat', 'global', 'own']);
  const noChat = toolCtx({ side: sideAnswer, conversationId: undefined });
  await assert.rejects(browserShowTools[0]!.run({ url: 'example.com', where: 'chat' }, noChat.ctx), /no chat area: where: 'global' is the person's pane, 'own' my area on my agent page/);
  // browser.open's own stays the agent's own browser: nothing goes to the person's browser
  const rig = scriptBrowser();
  await tool(browserTools(rig.browser), 'browser.open').run({ url: 'https://shop.test/', where: 'own' }, t.ctx);
  assert.equal(t.sideCalls.length, 1);
  await rig.browser.close();
});

test("the where line and the descriptions name each place and its logins: the ones made in those tabs, not the person's other browsers'", () => {
  const { browser } = scriptBrowser();
  assert.match(WHERE_HINT, /^chat: this chat's area above its messages – everyone here sees it, with the logins the person made in these tabs; global: the person's own pane, where they work; own: my own browser, with the logins I made in it\.$/);
  // browser.show's own is the agent's area in the person's browser, so it has its own where text
  const showWhere = (browserShowTools[0]!.inputSchema.properties as Record<string, { description: string }>).where!.description;
  assert.equal(showWhere, SHOW_WHERE);
  assert.match(showWhere, /own: my area on my agent page \(I keep it: space agent:<my id> in side-tabs\.json\) – all three in the person's browser, with the logins the person made there\./);
  assert.doesNotMatch(showWhere, /\b(my|your) own browser\b/);
  const texts = [WHERE_HINT, tool(browserTools(browser), 'browser.open').description, browserShowTools[0]!.description, showWhere];
  assert.match(texts[1]!, /in this chat's area \(where: chat\) or in the person's pane \(where: global\)/);
  assert.match(texts[2]!, /in this chat's area above the messages/);
  for (const line of texts) assert.doesNotMatch(line, /Chrome|saved sign-ins|their logins work|beside the chat/, line);
  // The hint is said once, in the environment's Browser line; the tools' `where` points there.
  const where = (tool(browserTools(browser), 'browser.open').inputSchema.properties as Record<string, { description: string }>).where!.description;
  assert.match(where, /as the Browser line of my environment says/);
  assert.ok(!where.includes(WHERE_HINT));
});

test('own browser: a click reports the agent\'s pointer; results name others pointing there and a human check; a takeover answers in one sentence', async () => {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  await tool(tools, 'browser.open').run({ url: 'https://shop.test/' }, t.ctx);
  const page = rig.page();
  page.snapshot = '- heading "Verify you are human"\n- button "Send" [ref=e2]';
  page.boxes.set('aria-ref=e2', { x: 100, y: 100, width: 80, height: 20 });
  t.pointers.point({ surface: 'agent:ag_ada/t1', actor: { kind: 'person', id: 'owner', name: 'Lukas' }, x: 5, y: 5 });
  const out = textOf(await tool(tools, 'browser.act').run({ action: 'click', ref: 'e2', motion: 'instant' }, t.ctx));
  assert.match(out, /^click element e2: done · page changed\./);
  assert.match(out, /Lukas/);
  assert.match(out, /This page shows a human check \(captcha\)\./);
  assert.ok(t.pointers.on('agent:ag_ada/t1').some((pointer) => pointer.actor.id === 'ag_ada'), 'the agent\'s pointer is on its tab');
  rig.browser.takeovers.start('ag_ada');
  await assert.rejects(tool(tools, 'browser.snapshot').run({}, t.ctx), /The person has taken over my browser/);
  await rig.browser.close();
});

test('save_secret stores a field\'s value once and returns only the handle; save_totp keeps the setup key in a login', async () => {
  const rig = scriptBrowser();
  const tools = browserTools(rig.browser);
  const t = toolCtx();
  const saved: Array<Record<string, unknown>> = [];
  const groups: Array<Record<string, unknown>> = [];
  Object.assign(t.services.secrets, {
    list: () => [], groups: () => [], holding: async (value: string) => (value === 'already-there' ? ['s9'] : []),
    save: async (input: Record<string, unknown>) => { saved.push(input); return { id: 'stripe-key', label: input.label, kind: input.kind }; },
    saveGroup: async (input: Record<string, unknown>) => { groups.push(input); return { group: { id: 'g1', label: input.label }, fields: [{ id: 'g1-totp', kind: 'totp' }] }; },
  });
  await assert.rejects(tool(tools, 'browser.save_secret').run({ ref: 'e7', label: 'Stripe key', purpose: 'Payments' }, t.ctx).then((out) => { if (out.isError) throw new Error(textOf(out)); }), /my own browser/);
  await tool(tools, 'browser.open').run({ url: 'https://dashboard.stripe.com/keys' }, t.ctx);
  const page = rig.page();
  (page as unknown as { locator(selector: string): unknown }).locator = (selector: string) => ({ inputValue: async () => (selector === 'aria-ref=e7' ? 'sk_live_123456789' : ''), getAttribute: async () => 'text', innerText: async () => '', first() { return this; }, nth() { return this; } });
  const out = await tool(tools, 'browser.save_secret').run({ ref: 'e7', label: 'Stripe key', purpose: 'Payments' }, t.ctx);
  assert.ok(!JSON.stringify(out).includes('sk_live_123456789'), 'the value never comes back');
  assert.match(textOf(out), /secret:\/\/stripe-key/);
  assert.deepEqual(saved[0], { label: 'Stripe key', kind: 'api_key', createdBy: 'ag_ada', value: 'sk_live_123456789', description: 'Payments', source: 'stripe.com' });

  page.onEvaluate = async (expression) => (expression.includes('otpauth') ? ['otpauth://totp/Stripe:ada?secret=JBSWY3DPEHPK3PXP&issuer=Stripe'] : []);
  page.snapshot = '- heading "Two-factor authentication"\n- text: Enter this key manually in your authenticator app: JBSW Y3DP EHPK 3PXP';
  const shown = textOf(await tool(tools, 'browser.snapshot').run({}, t.ctx));
  assert.ok(!shown.includes('JBSW Y3DP') && shown.includes('•••• (2FA setup key – save it with browser.save_totp)'), shown);
  const totp = await tool(tools, 'browser.save_totp').run({}, t.ctx);
  assert.match(textOf(totp), /secret:\/\/g1-totp/);
  assert.equal(groups[0]!.kind, 'login');
  assert.equal(groups[0]!.source, 'stripe.com');
  assert.ok(!JSON.stringify(totp).includes('JBSWY3DPEHPK3PXP'));
  await rig.browser.close();
});
