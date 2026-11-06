// web.search's keyless sources (tools/builtin/web-search.ts, E1): DuckDuckGo first, Bing when it answers with a bot
// check or nothing; Bing's result links decoded; every source failing ends in a search page to read with web.fetch.
// Owns: these assertions only. Never: network (a scripted fetch).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bingTarget, parseBing, searchPage, webSearchTool, type SearchFetch } from '../../../src/runtime/tools/builtin/web-search.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';

const b64 = (url: string) => `a1${Buffer.from(url).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
const bingLink = (url: string) => `https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;ptn=3&amp;u=${b64(url)}&amp;ntb=1`;
const BING = `<ol id="b_results"><li class="b_algo" data-id iid=SERP.1><div class="b_tpcn"><a class="tilk" href="${bingLink('https://e-move.at/katalog/')}">e-move.at</a></div>`
  + `<h2><a target="_blank" href="${bingLink('https://e-move.at/katalog/')}">Elektroautos &#214;sterreich 2026</a></h2><div class="b_caption"><p class="b_lineclamp2"><span class="news_dt">5. Okt. 2026</span>&nbsp;&#0183; 183 Elektroautos im Vergleich</p></div></li>`
  + `<li class="b_algo"><h2><a href="https://example.org/direct">Direct link</a></h2><p>Plain snippet</p></li>`
  + `<li class="b_algo"><h2><a href="${bingLink('https://e-move.at/katalog/')}">Duplicate</a></h2></li></ol>`;
const CHALLENGE = '<html><body><div class="anomaly-modal">bots use DuckDuckGo too</div></body></html>';

function fetcher(answers: Record<string, { status: number; body: string }>): { fetch: SearchFetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: SearchFetch = async (url) => {
    urls.push(url);
    const host = new URL(url).hostname;
    const answer = answers[host] ?? { status: 500, body: '' };
    return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'text/html' } });
  };
  return { fetch, urls };
}

const ctx = { agent: { id: 'ag_1' }, signal: new AbortController().signal, services: { secrets: { list: () => [] } } } as unknown as ToolContext;
const text = (output: ToolOutput) => (output.content[0] as { text: string }).text;

test('Bing links are decoded and its result blocks parsed (duplicates and Bing-internal links dropped)', () => {
  assert.equal(bingTarget(bingLink('https://e-move.at/katalog/')), 'https://e-move.at/katalog/');
  assert.equal(bingTarget('https://www.bing.com/search?q=x'), undefined);
  assert.equal(bingTarget(`https://www.bing.com/ck/a?u=${b64('https://www.bing.com/images')}`), undefined);
  const results = parseBing(BING);
  assert.deepEqual(results.map((r) => r.url), ['https://e-move.at/katalog/', 'https://example.org/direct']);
  assert.equal(results[0].title, 'Elektroautos Österreich 2026');
  assert.match(results[0].snippet, /183 Elektroautos im Vergleich/);
  assert.equal(results[1].snippet, 'Plain snippet');
});

test('DuckDuckGo answers with a bot check: Bing\'s results, the check named in the label', async () => {
  const { fetch, urls } = fetcher({ 'html.duckduckgo.com': { status: 202, body: CHALLENGE }, 'www.bing.com': { status: 200, body: BING } });
  const out = await webSearchTool({ fetch }).run({ query: 'Elektroauto selber bauen' }, ctx);
  assert.equal(out.isError, undefined);
  assert.match(text(out), /via Bing; DuckDuckGo: a bot check/);
  assert.match(text(out), /1\. Elektroautos Österreich 2026\n {3}https:\/\/e-move\.at\/katalog\//);
  assert.deepEqual(urls.map((u) => new URL(u).hostname), ['html.duckduckgo.com', 'www.bing.com']);
});

test('every keyless source failing: the answer names a search page to read with web.fetch or open in a browser', async () => {
  const { fetch } = fetcher({ 'html.duckduckgo.com': { status: 202, body: CHALLENGE }, 'www.bing.com': { status: 429, body: 'captcha' } });
  const out = await webSearchTool({ fetch }).run({ query: 'Wärmepumpe Förderung' }, ctx);
  assert.equal(out.isError, true);
  assert.ok(text(out).includes(`web.fetch ${searchPage('Wärmepumpe Förderung')}`), text(out));
  assert.match(text(out), /DuckDuckGo: a bot check.*Bing: a bot check/);
  assert.match(text(out), /browser\.open/);
});

test('DuckDuckGo with results is used as before (one request)', async () => {
  const ddg = '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a><a class="result__snippet">Snippet A</a>';
  const { fetch, urls } = fetcher({ 'html.duckduckgo.com': { status: 200, body: ddg } });
  const out = await webSearchTool({ fetch }).run({ query: 'example' }, ctx);
  assert.match(text(out), /via DuckDuckGo\]\n1\. Example A\n {3}https:\/\/example\.com\/a\n {3}Snippet A/);
  assert.equal(urls.length, 1);
});
