// browser.find, browser.console, browser.network, browser.eval and browser.wait – in the agent's own browser through
// inspect.ts, in the person's browser through its driver (side.ts); where a call goes is place.ts. find, console,
// network and wait only read; eval runs a script in the page (a device step like browser.act). Outputs carry the
// untrusted-content line and pass the vault's redaction.
// Owns: these schemas and outputs. Never: waits by polling.

import type { ToolDef, ToolOutput } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { SIDE_TEXT_MAX, SIDE_WAIT_MAX_MS } from '../../shared/model/side-browser.ts';
import type { BrowserService } from './service.ts';
import { consoleOf, evaluate, find, networkOf, wait, WAIT_MAX_MS, type WaitFor } from './inspect.ts';
import { sideCall, sidePage } from './side.ts';
import { pageText, sideOn, TAB_PROP, UNTRUSTED, useOf, WHERE_PROP, type On, type Places } from './place.ts';

const LIMIT = { type: 'integer', minimum: 1, maximum: 200 };
const ON = { tab: TAB_PROP, where: WHERE_PROP };
const read = (summary: string) => ({ summary, reversible: true, external: false });
const lines = (head: string, body: readonly string[], empty: string, structured: unknown): ToolOutput => ({ ...text([head, UNTRUSTED, ...(body.length ? body : [empty])].join('\n')), structured });

export function inspectTools(browser: BrowserService, places: Places): ToolDef[] {
  const device = { remote: true, requires: 'device' as const };

  const findTool = defineTool<On & { query: string }>({
    name: 'browser.find',
    description: 'Find elements on the page by words of their role, name or text ("button send", "price"); returns only the matching snapshot lines with refs for browser.act.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 200 }, ...ON }, required: ['query'], additionalProperties: false },
    category: 'read', ...device,
    describe: (args) => read(`Find "${args.query.slice(0, 80)}" on the browser page`),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'find', query: args.query, ...sideOn(ctx, place, args) });
        const page = sidePage(result);
        return { ...text(pageText(ctx, place, page, result.text || `Nothing on the page matches "${args.query}".`)), structured: { url: page.url, tab: page.tab } };
      }
      const found = await find(browser, ctx.agent.id, { tab: args.tab, query: args.query, use: useOf(ctx) });
      const body = found.lines.length ? [...found.lines, ...(found.total > found.lines.length ? [`… ${found.total - found.lines.length} more – narrow the query`] : [])].join('\n') : `Nothing on the page matches "${args.query}".`;
      return { ...text(pageText(ctx, 'own', found.state, body)), structured: { url: found.state.url, tab: found.state.tab, matches: found.total } };
    },
  });

  const consoleTool = defineTool<On & { pattern?: string; errorsOnly?: boolean; limit?: number }>({
    name: 'browser.console',
    description: 'The tab\'s console messages and uncaught errors since it opened (newest last), for debugging; filter by pattern or errorsOnly.',
    inputSchema: { type: 'object', properties: { pattern: { type: 'string', maxLength: 200 }, errorsOnly: { type: 'boolean' }, limit: LIMIT, ...ON }, additionalProperties: false },
    category: 'read', ...device,
    describe: () => read('Read the browser console'),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'console', ...(args.pattern ? { pattern: args.pattern } : {}), errorsOnly: args.errorsOnly === true, limit: args.limit ?? 50, ...sideOn(ctx, place, args) });
        return lines(`Console of tab ${result.tab ?? ''} · ${result.url ?? ''}`, (result.text ?? '').split('\n').filter(Boolean), 'No console messages.', { tab: result.tab });
      }
      const result = await consoleOf(browser, ctx.agent.id, { ...args, use: useOf(ctx) });
      return lines(`Console of tab ${result.tab} · ${result.url}`, result.lines, 'No console messages.', { tab: result.tab, count: result.lines.length });
    },
  });

  const network = defineTool<On & { urlPattern?: string; failedOnly?: boolean; limit?: number; requestId?: string }>({
    name: 'browser.network',
    description: 'The tab\'s requests since it opened (id, method, status, address, type, time; newest last) for debugging; filter by urlPattern or failedOnly; requestId shows one with its body (cookies and auth headers are not shown).',
    inputSchema: { type: 'object', properties: { urlPattern: { type: 'string', maxLength: 300 }, failedOnly: { type: 'boolean' }, limit: LIMIT, requestId: { type: 'string', maxLength: 40 }, ...ON }, additionalProperties: false },
    category: 'read', ...device,
    describe: (args) => read(args.requestId ? `Read browser request ${args.requestId}` : 'List browser requests'),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'network', ...(args.urlPattern ? { pattern: args.urlPattern } : {}), errorsOnly: args.failedOnly === true, limit: args.limit ?? 50, ...(args.requestId ? { requestId: args.requestId } : {}), ...sideOn(ctx, place, args) });
        return lines(`Requests of tab ${result.tab ?? ''} · ${result.url ?? ''}`, (result.text ?? '').split('\n').filter(Boolean), 'No requests.', { tab: result.tab });
      }
      const result = await networkOf(browser, ctx.agent.id, { ...args, use: useOf(ctx) });
      return lines(`Requests of tab ${result.tab} · ${result.url}`, result.lines, 'No requests.', { tab: result.tab });
    },
  });

  const evalTool = defineTool<On & { expression: string }>({
    name: 'browser.eval',
    description: 'Evaluate a JavaScript expression in the page and get its JSON result (capped) – for debugging; act with browser.act, read with browser.find/snapshot.',
    inputSchema: { type: 'object', properties: { expression: { type: 'string', minLength: 1, maxLength: 4000 }, ...ON }, required: ['expression'], additionalProperties: false },
    category: 'device', ...device,
    describe: (args) => ({ summary: `Run a script in the browser page: ${args.expression.replace(/\s+/g, ' ').slice(0, 120)}`, reversible: false, external: false }),
    async run(args, ctx) {
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'eval', expression: args.expression, ...sideOn(ctx, place, args) });
        return { ...text(`Tab ${result.tab ?? ''} · ${result.url ?? ''}\n${UNTRUSTED}\n---\n${(result.text ?? '').slice(0, SIDE_TEXT_MAX)}`), structured: { tab: result.tab } };
      }
      const result = await evaluate(browser, ctx.agent.id, { ...args, use: useOf(ctx) });
      return { ...text(`Tab ${result.tab} · ${result.url}\n${UNTRUSTED}\n---\n${result.text}${result.truncated ? '\n… (truncated)' : ''}`), structured: { tab: result.tab } };
    },
  });

  const waitTool = defineTool<On & WaitFor & { full?: boolean }>({
    name: 'browser.wait',
    description: `Wait until the page shows text, the address contains url, the page changes (change: true) or the network is idle (idle: true) – one of them, at most timeoutMs (≤ ${WAIT_MAX_MS / 1000} s); then get what changed.`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 300 }, url: { type: 'string', minLength: 1, maxLength: 500 }, change: { type: 'boolean' }, idle: { type: 'boolean' },
        timeoutMs: { type: 'integer', minimum: 100, maximum: Math.min(WAIT_MAX_MS, SIDE_WAIT_MAX_MS) }, ...ON, full: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    category: 'read', ...device,
    describe: () => read('Wait for the browser page'),
    async run(args, ctx) {
      const condition: WaitFor = { text: args.text, url: args.url, change: args.change, idle: args.idle, timeoutMs: args.timeoutMs };
      ctx.status('waiting for the page');
      const place = places.use(ctx, args);
      if (place !== 'own') {
        const result = await sideCall(ctx, { action: 'wait', wait: condition, ...sideOn(ctx, place, args) }, 'any');
        const page = sidePage(result);
        const head = result.ok ? 'Waited: it came.' : `Waited: it did not come in time${result.error ? ` (${result.error.slice(0, 200)})` : ''}.`;
        return { ...text(pageText(ctx, place, page, result.changes ?? result.text ?? '', head)), structured: { url: page.url, tab: page.tab, met: result.ok } };
      }
      const outcome = await wait(browser, ctx.agent.id, { tab: args.tab, for: condition, full: args.full, use: useOf(ctx) });
      const head = `Waited ${Math.round(outcome.waitedMs / 100) / 10} s: ${outcome.met ? 'it came' : 'it did not come in time'} · page ${outcome.changed ? 'changed' : 'did not change'}.`;
      return { ...text(pageText(ctx, 'own', outcome, outcome.changes.text, head)), structured: { url: outcome.url, tab: outcome.tab, met: outcome.met, changed: outcome.changed } };
    },
  });

  return [findTool, consoleTool, network, evalTool, waitTool];
}
