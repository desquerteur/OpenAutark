// browser.* tools. An agent browses in its own browser (its own profile: the logins it made stay – service.ts) or in the
// person's browser – `where: 'chat'` (this chat's area above its messages, shared by everyone in the chat) or 'global'
// (the person's own pane), with the logins the person made in those tabs (side.ts). A call goes where the agent worked
// last unless `where` or a tab id says otherwise (place.ts); a page opened there without newTab takes the agent's preview
// tab (show-tool.ts PREVIEW_HINT). 'own' here is always the agent's own browser; its area on its agent page takes pages
// through browser.show (show-tool.ts). Stored secrets fill by handle in both (value
// "secret://<id>"). Page results carry the untrusted-content line, the others pointing at that tab (named cursors,
// runtime/pointers), a human check as a fact and `structured.url` (the registry's site hints). browser.find/console/network/eval/wait are inspect-tools.ts,
// browser.save_secret and browser.save_totp secret-tools.ts.
// Owns: schemas, where a call goes, summaries and outputs. Never: puts secret values into outputs.

import type { ToolContext, ToolDef, ToolOutput } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { imageOutput } from '../computer/tools.ts';
import { MOTION_STYLES, type MotionStyle } from '../../shared/model/pointer-motion.ts';
import { BATCH_MAX, type BatchOutcome, type BatchStep, type BrowserService } from './service.ts';
import { describeTarget, type BrowserAction, type BrowserTarget } from './page.ts';
import { POINTER_ACTIONS } from './motion.ts';
import { SECRET, sideCall, sidePage, sideStep, type StepArgs } from './side.ts';
import { maskSetupKeys, pageText, Places, sideOn, surfaceOf, TAB_PROP, UNTRUSTED, useOf, WHERE_PROP, type On } from './place.ts';
import { inspectTools } from './inspect-tools.ts';
import { secretTools } from './secret-tools.ts';
import { PREVIEW_HINT } from './show-tool.ts';

const ACTIONS: BrowserAction[] = [
  'click', 'double_click', 'right_click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'scroll_into_view', 'upload', 'scroll', 'back', 'forward', 'reload',
];

const STEP_PROPS = {
  action: { type: 'string', enum: ACTIONS },
  ref: { type: 'string', maxLength: 24, description: 'element ref from the last snapshot (e12 in my browser, s123 in the person\'s) – preferred' },
  role: { type: 'string', maxLength: 40, description: 'ARIA role, e.g. button, link, textbox, checkbox, combobox' },
  name: { type: 'string', maxLength: 300, description: 'accessible name used with role' },
  label: { type: 'string', maxLength: 300 },
  placeholder: { type: 'string', maxLength: 300 },
  text: { type: 'string', maxLength: 300 },
  css: { type: 'string', maxLength: 500 },
  exact: { type: 'boolean' },
  nth: { type: 'integer', minimum: 0, maximum: 500 },
  value: { type: 'string', maxLength: 20_000, description: 'fill/type text, or secret://<id> for a stored secret' },
  values: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 50 },
  key: { type: 'string', maxLength: 40, description: 'press: Enter, Tab, Escape, ArrowDown, Control+A …' },
  files: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 20, description: 'upload: paths inside the workspace (my own browser)' },
  amount: { type: 'integer', minimum: -20_000, maximum: 20_000, description: 'scroll pixels (positive = down)' },
  submit: { type: 'boolean', description: 'true when this sends, posts, pays, books or signs in (journaled as an outside effect)' },
};

const MOTION_PROP = { type: 'string', enum: [...MOTION_STYLES], description: 'how the mouse moves: glide (default for act), instant (default for batch), human (recordings)' };
const FULL_PROP = { type: 'boolean', description: 'the whole snapshot instead of the change list' };

type ActArgs = StepArgs & BrowserTarget & { action: BrowserAction; submit?: boolean };

const hostOf = (url: string) => { try { return new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`).hostname || undefined; } catch { return undefined; } };
const hasTarget = (args: BrowserTarget) => Boolean(args.ref || args.role || args.label || args.placeholder || args.text || args.css);
const targetOf = (args: BrowserTarget): BrowserTarget | undefined => (hasTarget(args)
  ? { ref: args.ref, role: args.role, name: args.name, label: args.label, placeholder: args.placeholder, text: args.text, css: args.css, exact: args.exact, nth: args.nth } : undefined);

/** 'click element e3', 'fill field "Email" (stored secret)'. */
function stepSummary(args: ActArgs): string {
  const secret = args.value && SECRET.test(args.value) ? ' (stored secret)' : '';
  return `${args.action.replace(/_/g, ' ')} ${describeTarget(targetOf(args))}${args.action === 'press' ? ` ${args.key ?? ''}` : ''}${secret}`.trim();
}

function ownStep(args: ActArgs): BatchStep {
  const secretId = args.value !== undefined ? SECRET.exec(args.value)?.[1] : undefined;
  return { action: args.action, target: targetOf(args), ...(secretId ? { secretId } : { value: args.value }), values: args.values, key: args.key, files: args.files, amount: args.amount };
}

/** Runs steps in either browser and answers like one call (browser.act is one step). */
async function runSteps(browser: BrowserService, places: Places, ctx: ToolContext, args: On & { steps: ActArgs[]; motion?: MotionStyle; full?: boolean }, motion: MotionStyle): Promise<ToolOutput> {
  const place = places.use(ctx, args);
  const summaries = args.steps.map(stepSummary);
  const outside = args.steps.some((step) => step.submit === true);
  const one = args.steps.length === 1;
  ctx.status(one ? summaries[0]! : `${args.steps.length} browser steps`);
  const why = (failure: string) => failure.replace(/\.$/, '');
  const headOf = (done: number, failure: string | undefined, after = '') => `${one
    ? `${summaries[0]}: ${failure ? `failed – ${why(failure)}` : 'done'}`
    : `Batch: ${done} of ${args.steps.length} steps done${failure ? ` – step ${done + 1} (${summaries[done] ?? 'next'}) failed: ${why(failure)}` : ''}`}${after}.`;
  if (place !== 'own') {
    const steps = await Promise.all(args.steps.map((step) => sideStep(ctx, step)));
    const result = await sideCall(ctx, { action: 'act', steps, motion: args.motion ?? motion, ...sideOn(ctx, place, args) }, true);
    const done = result.done ?? (result.ok ? steps.length : 0);
    const page = sidePage(result);
    return {
      ...text(pageText(ctx, place, page, result.changes ?? result.text ?? '', headOf(done, result.ok ? undefined : result.error ?? 'unknown'))),
      ...(done === 0 && !result.ok ? { isError: true } : {}),
      effect: outside ? { status: done === steps.length ? 'unknown' : 'failed' } : undefined, structured: { url: page.url, tab: page.tab, done },
    };
  }
  const outcome: BatchOutcome = await browser.batch(ctx.agent.id, {
    tab: args.tab, steps: args.steps.map(ownStep), motion: args.motion ?? motion, full: args.full, use: useOf(ctx),
    secret: (id, host) => ctx.services.secrets.use(id, ctx.agent.id, host),
  });
  const pointed = args.steps.slice(0, outcome.done).filter((step) => POINTER_ACTIONS.has(step.action) && hasTarget(step));
  outcome.points.forEach((point, index) => {
    const step = pointed[index];
    try {
      ctx.services.pointers?.point({
        surface: surfaceOf(ctx, place, point.tab), actor: { kind: 'agent', id: ctx.agent.id, name: ctx.agent.name }, x: point.x, y: point.y,
        action: step?.action === 'hover' ? 'move' : 'click', path: point.path, ...(step?.ref ? { target: { ref: step.ref } } : {}),
      });
    } catch { /* a cursor is a hint; the step counts */ }
  });
  const moved = `${outcome.urlChanged ? ` (now ${outcome.url})` : ''}${outcome.newTab ? ` (now in tab ${outcome.tab})` : ''}`;
  const all = outcome.done === outcome.total;
  return {
    ...text(pageText(ctx, place, outcome, outcome.changes.text, headOf(outcome.done, outcome.failure, ` · page ${outcome.changed ? 'changed' : 'did not change'}${moved}`))),
    ...(outcome.done === 0 && outcome.failure ? { isError: true } : {}),
    effect: outside ? { status: !all ? 'failed' : outcome.changed ? 'confirmed' : 'unknown' } : undefined,
    structured: { done: outcome.done, total: outcome.total, changed: outcome.changed, url: outcome.url, tab: outcome.tab, full: outcome.changes.full },
  };
}

export function browserTools(browser: BrowserService): ToolDef[] {
  const places = new Places();
  const device = { remote: true, requires: 'device' as const };

  const open = defineTool<{ url: string; newTab?: boolean } & On>({
    name: 'browser.open',
    description: "Open a URL in my own browser (my profile: the logins I made stay), in this chat's area (where: chat) or in the person's pane (where: global) – the person sees those two, with the logins they made there. Returns the page as an accessibility snapshot with element refs.",
    inputSchema: { type: 'object', properties: { url: { type: 'string', minLength: 1, maxLength: 4000 }, newTab: { type: 'boolean', description: `Without it the page takes my current tab – in the chat area or the person's pane: ${PREVIEW_HINT}` }, tab: TAB_PROP, where: WHERE_PROP }, required: ['url'], additionalProperties: false },
    category: 'read', ...device,
    describe: (args) => ({ summary: `Open ${args.url}`, resource: hostOf(args.url), reversible: true, external: false }),
    async run(args, ctx) {
      ctx.status(`opening ${hostOf(args.url) ?? 'a page'}`);
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const newTab = args.tab ? false : args.newTab; // left out: the agent's preview tab there (main/workspace-marks.ts)
        const result = await sideCall(ctx, { action: 'open', url: args.url, ...(newTab === undefined ? {} : { newTab }), ...sideOn(ctx, place, args) });
        const page = sidePage(result);
        return { ...text(pageText(ctx, place, page, result.text ?? '')), structured: { url: page.url, tab: page.tab } };
      }
      const state = await browser.open(ctx.agent.id, { url: args.url, newTab: args.newTab, tab: args.tab, use: useOf(ctx) });
      return { ...text(pageText(ctx, place, state, state.snapshot)), structured: { url: state.url, tab: state.tab } };
    },
  });

  const snapshot = defineTool<On>({
    name: 'browser.snapshot',
    description: 'Accessibility snapshot of the current tab (roles, names, values, refs). Use refs with browser.act; browser.find returns only matching lines.',
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Read the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'snapshot', full: true, ...sideOn(ctx, place, args) });
        const page = sidePage(result);
        return { ...text(pageText(ctx, place, page, result.text ?? '')), structured: { url: page.url, tab: page.tab } };
      }
      const state = await browser.snapshot(ctx.agent.id, { tab: args.tab, use: useOf(ctx) });
      return { ...text(pageText(ctx, place, state, state.snapshot)), structured: { url: state.url, tab: state.tab } };
    },
  });

  const act = defineTool<ActArgs & On & { motion?: MotionStyle; full?: boolean }>({
    name: 'browser.act',
    description: 'Do one thing on the page – click, fill (type = real key presses for autocomplete), press a key, select, (un)check, hover, upload a workspace file, scroll, back/forward/reload – and get what changed (full: the whole snapshot). Address elements by ref (best), role+name, label, placeholder, text or css. Stored secret or 2FA code: value "secret://<id>". Set submit: true when it sends, posts, pays or signs in. Many steps at once: browser.batch.',
    inputSchema: { type: 'object', properties: { ...STEP_PROPS, tab: TAB_PROP, where: WHERE_PROP, motion: MOTION_PROP, full: FULL_PROP }, required: ['action'], additionalProperties: false },
    category: 'device', ...device,
    describe: (args) => ({ summary: stepSummary(args), reversible: args.submit !== true, external: args.submit === true }),
    run: (args, ctx) => runSteps(browser, places, ctx, { tab: args.tab, where: args.where, full: args.full, motion: args.motion, steps: [args] }, 'glide'),
  });

  const batch = defineTool<On & { steps: ActArgs[]; motion?: MotionStyle; full?: boolean }>({
    name: 'browser.batch',
    description: `Run up to ${BATCH_MAX} browser.act steps on one tab in one call (fill a form, then click Send); stops at the first failing step and returns how many ran and one change list. The mouse jumps unless motion says otherwise.`,
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', minItems: 1, maxItems: BATCH_MAX, items: { type: 'object', properties: STEP_PROPS, required: ['action'], additionalProperties: false } },
        tab: TAB_PROP, where: WHERE_PROP, motion: MOTION_PROP, full: FULL_PROP,
      },
      required: ['steps'], additionalProperties: false,
    },
    category: 'device', ...device,
    describe: (args) => {
      const outside = args.steps.some((step) => step.submit === true);
      return { summary: `Batch of ${args.steps.length}: ${args.steps.map(stepSummary).join('; ')}`.slice(0, 900), reversible: !outside, external: outside };
    },
    run: (args, ctx) => runSteps(browser, places, ctx, args, 'instant'),
  });

  const screenshot = defineTool<On & { fullPage?: boolean }>({
    name: 'browser.screenshot',
    description: 'Screenshot of the current tab (viewport, or fullPage in my own browser). Use for visual checks; use browser.snapshot to find and act on elements.',
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, fullPage: { type: 'boolean' }, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Screenshot of the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'screenshot', ...sideOn(ctx, place, args) });
        if (!result.image) throw new Error("The person's browser sent no picture.");
        const page = sidePage(result);
        return imageOutput({ data: Buffer.from(result.image.data, 'base64'), mime: result.image.mime }, `Tab ${page.tab} · ${page.url} · "${page.title}"`, { url: page.url, tab: page.tab });
      }
      const shot = await browser.screenshot(ctx.agent.id, { tab: args.tab, fullPage: args.fullPage, use: useOf(ctx) });
      return imageOutput(shot, `Tab ${shot.tab} · ${shot.url} · "${shot.title}"`, { url: shot.url, tab: shot.tab });
    },
  });

  const extract = defineTool<On & { css?: string; maxChars?: number }>({
    name: 'browser.extract',
    description: 'Visible text of the page (in my own browser also of a css selector) for reading articles, tables, prices. Untrusted data.',
    inputSchema: { type: 'object', properties: { tab: TAB_PROP, css: { type: 'string', maxLength: 500 }, maxChars: { type: 'integer', minimum: 500, maximum: 100_000 }, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => ({ summary: 'Read text from the browser page', reversible: true, external: false }),
    async run(args, ctx) {
      let result: { text: string; truncated: boolean; tab: string; url: string; title: string };
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const side = await sideCall(ctx, { action: 'text', ...sideOn(ctx, place, args) });
        const max = Math.max(500, Math.min(args.maxChars ?? 30_000, 100_000));
        const raw = side.text ?? '';
        result = { ...sidePage(side), text: raw.slice(0, max), truncated: raw.length > max };
      } else {
        result = await browser.extract(ctx.agent.id, { tab: args.tab, css: args.css, maxChars: args.maxChars, use: useOf(ctx) });
      }
      return { ...text(`Tab ${result.tab} · ${result.url} · "${result.title}"\n${UNTRUSTED}\n---\n${maskSetupKeys(result.text)}${result.truncated ? '\n… (truncated)' : ''}`), structured: { url: result.url, tab: result.tab } };
    },
  });

  const tabs = defineTool<{ close?: string; activate?: string; where?: On['where'] }>({
    name: 'browser.tabs',
    description: 'List the open tabs (my own browser: also recent downloads saved to the workspace); close a tab, or switch to one of my own.',
    inputSchema: { type: 'object', properties: { close: TAB_PROP, activate: TAB_PROP, where: WHERE_PROP }, additionalProperties: false },
    category: 'read', ...device,
    describe: (args) => ({ summary: args.close ? `Close tab ${args.close}` : 'List browser tabs', reversible: true, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, { where: args.where, tab: args.close ?? args.activate });
      if (place !== 'own') {
        if (args.activate) throw new Error('Pass tab to work in another of these tabs.');
        const { space } = sideOn(ctx, place, {});
        const result = await sideCall(ctx, args.close ? { action: 'close', tab: args.close, space } : { action: 'tabs', space });
        const lines = (result.tabs ?? []).map((tab) => `- ${tab.id}${tab.active ? ' (the person looks at it)' : ''} · ${tab.url} · "${tab.title}"${tab.by ? ` · opened by ${tab.by}` : ''}`);
        return { ...text(lines.length ? lines.join('\n') : 'No open tabs.'), structured: { tabs: result.tabs ?? [] } };
      }
      const result = await browser.tabs(ctx.agent.id, { close: args.close, activate: args.activate, use: useOf(ctx) });
      const lines = result.tabs.map((tab) => `- ${tab.tab}${tab.active ? ' (current)' : ''} · ${tab.url} · "${tab.title}"`);
      if (!lines.length) lines.push('No open tabs.');
      if (result.downloads.length) lines.push('Downloads (workspace):', ...result.downloads.map((file) => `- ${file}`));
      return { ...text(lines.join('\n')), structured: result };
    },
  });

  return [open, snapshot, act, batch, screenshot, extract, tabs, ...inspectTools(browser, places), ...secretTools(browser)];
}
