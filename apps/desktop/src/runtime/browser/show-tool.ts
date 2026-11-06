// browser.show: an agent shows the person a web page – it opens as a tab in this chat's area above the messages and is
// shown there at once (a closed area's cell in the app gets a dot). Without a chat it goes to the person's pane (global);
// `where` says otherwise – own: the agent's own area on its agent page (agent:<id>, place.ts sideOn). The tab carries the
// agent and the chat; without `newTab` it is the agent's preview tab there (main/workspace-marks.ts). It is no device
// tool (offered in every mode); it goes through main (host op sideBrowser).
// Owns: the tool, its own where text (its 'own' is the agent's area, not the agent's browser) and the preview hint
// browser.open shares. Never: reads the page (browser.open with where: chat or global does).

import type { ToolDef } from '../tools/types.ts';
import { text } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { browserUrl } from '../../shared/api/workspace-browser.ts';
import { sideCall } from './side.ts';
import { sideOn, type Place } from './place.ts';

export const BROWSER_SHOW_TOOL = 'browser.show';

/** What newTab does in the person's browser (browser.open and browser.show). */
export const PREVIEW_HINT = 'my preview tab there, which my next page replaces until the person uses it; true: a tab of its own.';

/** browser.show's places – all three in the person's browser. */
export const SHOW_WHERE = "chat: this chat's area above its messages (everyone here sees it); global: the person's own pane; own: my area on my agent page (I keep it: space agent:<my id> in side-tabs.json) – all three in the person's browser, with the logins the person made there. Default: chat when this run has one, else global.";
const SHOW_NO_CHAT = "This run has no chat, so there is no chat area: where: 'global' is the person's pane, 'own' my area on my agent page.";

/** Where the result says the page went. */
const PLACE_NAME: Record<Place, string> = { chat: "this chat's area", global: "the person's pane", own: 'my area on my agent page' };

/** The address as the person's browser opens it; a bad one fails with the reason. */
export function showUrl(input: string): string {
  try { return new URL(browserUrl(input)).href; } catch (error) {
    throw new WorkforceError('bad_request', error instanceof Error ? error.message : 'Use an HTTP or HTTPS address.', { details: { param: 'url' } });
  }
}

const show = defineTool<{ url: string; where?: Place; newTab?: boolean }>({
  name: BROWSER_SHOW_TOOL,
  description: "Show the person a web page: it opens as a tab in this chat's area above the messages (where: global – the person's own pane; own – my area on my agent page). To read or work in it myself, I use browser.open with where: chat or global.",
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', minLength: 1, maxLength: 4000, description: 'http(s) address, e.g. https://example.com/pricing or localhost:5173' },
      where: { type: 'string', enum: ['chat', 'global', 'own'], description: SHOW_WHERE },
      newTab: { type: 'boolean', description: `Without it the page takes ${PREVIEW_HINT}` },
    },
    required: ['url'],
    additionalProperties: false,
  },
  category: 'read',
  describe: (args) => ({ summary: `Show ${String(args.url).slice(0, 200)} in the person's browser`, reversible: true, external: false }),
  async run(args, ctx) {
    const url = showUrl(args.url);
    if (args.where === 'chat' && !ctx.conversationId) throw new WorkforceError('bad_request', SHOW_NO_CHAT);
    const place = args.where ?? (ctx.conversationId ? 'chat' : 'global');
    const result = await sideCall(ctx, { action: 'open', url, ...(args.newTab === undefined ? {} : { newTab: args.newTab }), show: true, ...sideOn(ctx, place, {}) });
    return { ...text(`Opened ${url} in ${PLACE_NAME[place]} (tab ${result.tab ?? ''}).`), structured: { url, tab: result.tab } };
  },
});

export const browserShowTools: ToolDef[] = [show];
