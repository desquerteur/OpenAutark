// Parser tests: fence segmentation, streaming, stable indexes, lenient JSON (B-076: German and curly
// quotes inside strings stay), aliases, coercions, validation, repair notes (named by id, counted from 1)
// and limits – including typical malformed model output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appHtmlOf, appTodosOf, blockKey, parseAppInfo, parseMessage, parseUiFence,
  repairNotesOf, repairStreamingTail, uiBlocksOf,
} from '../../../src/shared/blocks/parse.ts';
import type { Part } from '../../../src/shared/blocks/parse.ts';
import { LIMITS } from '../../../src/shared/blocks/catalog.ts';

const F = '```';
const ui = (json: string): string => `${F}ui\n${json}\n${F}`;

function one(json: string) {
  const results = parseUiFence(json);
  assert.equal(results.length, 1);
  return results[0];
}
function ok(json: string) {
  const result = one(json);
  assert.ok(result.ok, result.ok ? '' : `expected ok, got: ${result.error}`);
  return result.block;
}
function kinds(parts: Part[]): string[] {
  return parts.map(p => p.kind);
}

// ---------------------------------------------------------------- segmentation

test('plain markdown is one part', () => {
  const parts = parseMessage('Hello **world**\n\n- a\n- b');
  assert.deepEqual(kinds(parts), ['markdown']);
});

test('text, ui, text, mermaid, code are split in order', () => {
  const body = `Intro\n\n${ui('{"type":"callout","text":"Hi"}')}\n\nMiddle\n\n${F}mermaid\nflowchart LR\nA-->B\n${F}\n\n${F}ts\nconst a = 1;\n${F}\nEnd`;
  assert.deepEqual(kinds(parseMessage(body)), ['markdown', 'ui', 'markdown', 'mermaid', 'code', 'markdown']);
});

test('html and json fences are never live UI', () => {
  const parts = parseMessage(`${F}html\n<b>x</b>\n${F}\n${F}json\n{"type":"callout","text":"x"}\n${F}`);
  assert.deepEqual(kinds(parts), ['code', 'code']);
  assert.equal((parts[0] as { lang: string }).lang, 'html');
});

test('tilde fences and longer backtick fences work', () => {
  const parts = parseMessage(`~~~ui\n{"type":"callout","text":"x"}\n~~~`);
  assert.equal(parts[0].kind, 'ui');
  const nested = parseMessage(`${F}\`markdown\nExample:\n${F}ui\n{"type":"callout","text":"x"}\n${F}\n${F}\``);
  assert.deepEqual(kinds(nested), ['code']); // a ```ui inside a ```` fence is shown as code
});

test('indented fences inside lists are recognized', () => {
  const parts = parseMessage(`1. Step\n   ${F}ui\n   {"type":"callout","text":"x"}\n   ${F}`);
  assert.deepEqual(kinds(parts), ['markdown', 'ui']);
});

test('CRLF line endings are handled', () => {
  const parts = parseMessage(`a\r\n${F}ui\r\n{"type":"callout","text":"x"}\r\n${F}\r\nb`);
  assert.deepEqual(kinds(parts), ['markdown', 'ui', 'markdown']);
});

test('language is case-insensitive and accepts aliases', () => {
  assert.equal(parseMessage(`${F}UI\n{"type":"callout","text":"x"}\n${F}`)[0].kind, 'ui');
  assert.equal(parseMessage(`${F}Mermaid\nflowchart TD\nA\n${F}`)[0].kind, 'mermaid');
});

// ---------------------------------------------------------------- streaming

test('unclosed ui fence while streaming is pending with a type hint', () => {
  const parts = parseMessage(`Text\n${F}ui\n{"type": "chart", "kind": "bar", "data": [`, { streaming: true });
  assert.deepEqual(kinds(parts), ['markdown', 'ui-pending']);
  assert.equal((parts[1] as { hint?: string }).hint, 'chart');
});

test('unclosed ui fence in a final message is accepted when the JSON is complete', () => {
  const parts = parseMessage(`${F}ui\n{"type":"callout","text":"x"}`);
  assert.equal(parts[0].kind, 'ui');
  assert.ok((parts[0] as { result: { ok: boolean } }).result.ok);
});

test('unclosed ui fence in a final message with cut JSON reports cut off', () => {
  const parts = parseMessage(`${F}ui\n{"type":"choice","question":"x","options":["a",`);
  const result = (parts[0] as Extract<Part, { kind: 'ui' }>).result;
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /cut off/); assert.equal(result.ask, true); }
});

test('indexes are stable while a message streams', () => {
  const full = `${ui('{"type":"callout","text":"a"}')}\n${F}app\n<p>x</p>\n${F}\n${ui('[{"type":"callout","text":"b"},{"type":"choice","question":"q","options":["y","n"]}]')}`;
  const finalIdx = parseMessage(full).flatMap(p => ('index' in p ? [p.index] : []));
  assert.deepEqual(finalIdx, [0, 1, 2, 3]);
  for (let cut = 1; cut < full.length; cut += 7) {
    const partial = parseMessage(full.slice(0, cut), { streaming: true });
    const indexes = partial.flatMap(p => ('index' in p && p.index >= 0 ? [p.index] : []));
    assert.deepEqual(indexes, finalIdx.slice(0, indexes.length), `cut at ${cut}`);
  }
});

test('mermaid and code fences do not consume indexes', () => {
  const body = `${F}mermaid\nflowchart LR\nA-->B\n${F}\n${F}js\nx\n${F}\n${ui('{"type":"callout","text":"x"}')}`;
  const part = parseMessage(body).find(p => p.kind === 'ui') as Extract<Part, { kind: 'ui' }>;
  assert.equal(part.index, 0);
});

test('streaming app fence shows a skeleton without an index', () => {
  const parts = parseMessage(`${F}app title="Calc"\n<div>`, { streaming: true });
  const app = parts[0] as Extract<Part, { kind: 'app' }>;
  assert.equal(app.kind, 'app');
  assert.equal(app.index, -1);
  assert.equal(app.attrs.title, 'Calc');
});

test('repairStreamingTail closes bold and code and hides half links', () => {
  assert.equal(repairStreamingTail('Hello **wor'), 'Hello **wor**');
  assert.equal(repairStreamingTail('Run `npm i'), 'Run `npm i`');
  assert.equal(repairStreamingTail('See [docs](https://exa'), 'See ');
  assert.equal(repairStreamingTail('Done.'), 'Done.');
});

// ---------------------------------------------------------------- lenient JSON

test('JSON5-ish input: comments, trailing commas, single quotes, unquoted keys', () => {
  const block = ok(`{
    // a comment
    type: 'callout', /* inline */ tone: "success",
    text: 'It\\'s done',
  }`);
  assert.equal(block.type, 'callout');
  assert.equal(block.tone, 'success');
  assert.equal(block.text, "It's done");
});

test('smart quotes and Python literals are accepted', () => {
  const block = ok('{“type”: “choice”, “question”: “Go?”, “options”: [“Yes”, “No”], “multi”: False}');
  assert.equal(block.multi, false);
  assert.equal((block.options as unknown[]).length, 2);
});

test('German and curly quotes inside strings stay as written (B-076)', () => {
  const block = ok('{"type":"choice","id":"zuerst","question":"Was zuerst?","options":["Buch „Vom Modell zum Produkt“ fertig bekommen","Den “Launch” planen","Kurs ″Basics″"]}');
  assert.deepEqual((block.options as Array<{ label: string }>).map((option) => option.label), ['Buch „Vom Modell zum Produkt“ fertig bekommen', 'Den “Launch” planen', 'Kurs ″Basics″']);
  const titled = ok('{"type":"callout","text":"Er sagte: „Los geht’s“ – und ging."}');
  assert.equal(titled.text, 'Er sagte: „Los geht’s“ – und ging.');
});

test('smart quotes as delimiters still read: German „…“ pairs, nested quotes in a smart-quoted string, mixed "…”', () => {
  const german = ok('{„type“: „choice“, „question“: „Welches Buch?“, „options“: [„A“, „B“]}');
  assert.deepEqual((german.options as Array<{ label: string }>).map((option) => option.label), ['A', 'B']);
  const nested = ok('{“type”: “callout”, “text”: “Buch „Vom Modell“ fertig”}');
  assert.equal(nested.text, 'Buch „Vom Modell“ fertig');
  const mixed = ok('{"type": "callout", "text": "Hallo”}');
  assert.equal(mixed.text, 'Hallo', 'a string opened with " and closed with ” is repaired as before');
});

test('raw newlines inside strings are kept', () => {
  const block = ok('{"type":"callout","text":"line one\nline two"}');
  assert.equal(block.text, 'line one\nline two');
});

test('a repeated "json" line inside the fence is ignored', () => {
  ok('json\n{"type":"callout","text":"x"}');
});

test('several objects without an array (JSONL) become several blocks', () => {
  const results = parseUiFence('{"type":"callout","text":"a"}\n{"type":"callout","text":"b"}');
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.ok));
});

test('an array produces one result per element; one bad element does not kill the others', () => {
  const results = parseUiFence('[{"type":"callout","text":"a"},{"type":"nope"},{"type":"callout","text":"c"}]');
  assert.deepEqual(results.map(r => r.ok), [true, false, true]);
});

test('missing commas between properties are repaired', () => {
  const block = ok('{"type":"callout" "text":"x"}');
  assert.equal(block.text, 'x');
});

test('garbage is reported as invalid JSON with the source kept', () => {
  const result = one('this is not json');
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /invalid JSON/); assert.equal(result.source, 'this is not json'); }
});

test('empty fence is an error', () => {
  assert.equal(one('   ').ok, false);
});

test('__proto__ keys are dropped', () => {
  const block = ok('{"type":"callout","text":"x","__proto__":{"polluted":true}}');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(block.text, 'x');
});

// ---------------------------------------------------------------- types, aliases, validation

test('unknown type fails as a display error (no repair note)', () => {
  const result = one('{"type":"hologram"}');
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /unknown type/); assert.equal(result.ask, false); }
});

test('missing type fails', () => {
  assert.equal(one('{"text":"x"}').ok, false);
});

test('aliases map to catalog types', () => {
  assert.equal(ok('{"type":"reminder","label":"Call mom","at":"17:00"}').type, 'timer');
  const yesNo = ok('{"type":"approval","action":"Pay the invoice"}'); // B-078: a yes/no is a quick reply
  assert.equal(yesNo.type, 'choice');
  assert.equal(yesNo.question, 'Pay the invoice');
  assert.deepEqual((yesNo.options as Array<{ label: string }>).map((option) => option.label), ['Yes', 'No']);
  assert.equal(ok('{"type":"kpi","items":[{"label":"Users","value":"1.2k"}]}').type, 'stats');
  assert.equal(ok('{"type":"buttons","question":"Pick","options":["a"]}').type, 'choice');
  assert.equal(ok('{"type":"Todo-List","items":["a"]}').type, 'checklist');
});

test('component/widget keys work instead of "type"', () => {
  assert.equal(ok('{"component":"callout","text":"x"}').type, 'callout');
  assert.equal(ok('{"widget":"timer","label":"x","duration":"10m"}').type, 'timer');
});

test('teleprompter alias becomes a video recorder; script implies video', () => {
  const tele = ok('{"type":"teleprompter","script":"Hi there"}');
  assert.equal(tele.type, 'record');
  assert.equal(tele.mode, 'video');
  assert.equal(ok('{"type":"recorder"}').mode, 'audio');
  assert.equal(ok('{"type":"record","mode":"webcam"}').mode, 'video');
});

test('warning alias sets the tone; flowchart hints become a callout', () => {
  assert.equal(ok('{"type":"warning","text":"careful"}').tone, 'warning');
  const flow = ok('{"type":"flowchart","text":"A then B"}');
  assert.equal(flow.type, 'callout');
});

test('required props are enforced with a short error; ask errors produce repair notes', () => {
  const result = one('{"type":"choice","question":"Which?"}');
  assert.equal(result.ok, false);
  if (!result.ok) { assert.equal(result.error, '"options" missing in choice'); assert.equal(result.ask, true); }
  const notes = repairNotesOf(ui('{"type":"callout","text":"x"}') + '\n' + ui('{"type":"choice","question":"Which?"}'));
  assert.deepEqual(notes, ['[ui-error block "Which?" (2nd block): "options" missing in choice] I send that block again, fixed.']);
});

test('a repair note names the block by its id (else its question), counted from 1 – also when its JSON is broken (B-076)', () => {
  const body = [
    ui('{"type":"callout","text":"Plan"}'),
    ui('{"type":"choice","id":"tempo","question":"Wie schnell?","options":["Sofort","Später"]}'),
    ui('{"type":"choice","id":"zuerst","question":"Was zuerst?","options":["Buch “Vom Modell" fertig"]}'),
    ui('{"type":"approve"}'),
  ].join('\n');
  const notes = repairNotesOf(body);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /^\[ui-error block "zuerst" \(3rd block\): invalid JSON: .+\] I send that block again, fixed\.$/);
  assert.equal(notes[1], '[ui-error block (4th block, approve): "action" missing in approve] I send that block again, fixed.');
});

test('unknown props are dropped; host-only props cannot be injected', () => {
  const block = ok('{"type":"approve","action":"Pay","approvalId":"apr_123","binding":true,"onClick":"x"}');
  assert.equal(block.approvalId, undefined);
  assert.equal(block.binding, undefined);
  assert.equal(block.onClick, undefined);
});

test('ask defaults: todo only when written, important kept, priority normalized, due kept; display blocks have no todo', () => {
  const block = ok('{"type":"confirm","instructions":"Sign","priority":"URGENT","due":"PT2H"}');
  assert.equal(block.todo, undefined, 'B-078 D9: catalog.ts becomesTodo decides the list');
  assert.equal(ok('{"type":"confirm","instructions":"x","todo":true}').todo, true);
  assert.equal(ok('{"type":"choice","question":"q","options":["a"],"important":"yes"}').important, true);
  assert.equal(ok('{"type":"choice","question":"q","options":["a"],"important":false}').important, undefined);
  assert.equal(block.priority, 'high');
  assert.equal(block.due, 'PT2H');
  assert.equal(ok('{"type":"callout","text":"x"}').todo, undefined);
  assert.equal(ok('{"type":"confirm","instructions":"x","todo":"no"}').todo, false);
});

test('ids are slugged', () => {
  assert.equal(ok('{"type":"progress","id":"Render Video #1","label":"x"}').id, 'render-video-1');
});

// ---------------------------------------------------------------- coercions per type

test('string where an array is expected becomes a one-item array', () => {
  const block = ok('{"type":"record","mode":"video","bullets":"Say hello"}');
  assert.deepEqual(block.bullets, ['Say hello']);
});

test('booleans from strings', () => {
  assert.equal(ok('{"type":"choice","question":"q","options":["a"],"multi":"yes"}').multi, true);
});

test('choice options as a pipe string, objects and over-limit lists', () => {
  assert.deepEqual((ok('{"type":"choice","question":"q","options":"A | B | C"}').options as Array<{ label: string }>).map(o => o.label), ['A', 'B', 'C']);
  const many = Array.from({ length: 12 }, (_, i) => `"o${i}"`).join(',');
  assert.equal((ok(`{"type":"choice","question":"q","options":[${many}]}`).options as unknown[]).length, LIMITS.choiceOptions);
  const objs = ok('{"type":"choice","question":"q","options":[{"text":"Yes","value":"y"}]}').options as Array<{ label: string; value: string }>;
  assert.deepEqual(objs[0], { label: 'Yes', value: 'y' });
});

test('chart: numbers in strings parsed, x/y inferred, pie → donut, limits', () => {
  const block = ok('{"type":"chart","kind":"pie","data":[{"name":"A","share":"40%"},{"name":"B","share":"1.234,5"}]}');
  assert.equal(block.kind, 'donut');
  assert.equal(block.x, 'name');
  assert.equal(block.y, 'share');
  assert.deepEqual((block.data as Array<{ share: number }>).map(d => d.share), [40, 1234.5]);
  const points = Array.from({ length: LIMITS.chartPoints + 10 }, (_, i) => `{"x":"${i}","y":${i}}`).join(',');
  assert.equal((ok(`{"type":"chart","kind":"line","x":"x","y":"y","data":[${points}]}`).data as unknown[]).length, LIMITS.chartPoints);
});

test('chart without numeric series fails', () => {
  assert.equal(one('{"type":"chart","kind":"bar","data":[{"a":"x","b":"y"}]}').ok, false);
});

test('table: object rows infer columns, rows become arrays, rows limited', () => {
  const block = ok('{"type":"table","rows":[{"Name":"A","Price":3},{"Name":"B","Price":4}]}');
  assert.deepEqual((block.columns as Array<{ key: string }>).map(c => c.key), ['Name', 'Price']);
  assert.deepEqual(block.rows, [['A', '3'], ['B', '4']]);
  const rows = Array.from({ length: LIMITS.tableRows + 5 }, (_, i) => `[${i}]`).join(',');
  const big = ok(`{"type":"table","columns":["n"],"rows":[${rows}]}`);
  assert.equal((big.rows as unknown[]).length, LIMITS.tableRows);
  assert.equal(big.truncated, LIMITS.tableRows + 5);
});

test('steps: strings become titles, status synonyms normalized', () => {
  const block = ok('{"type":"plan","items":["Cut",{"title":"Mix","status":"in progress"},{"label":"Export","status":"completed"}]}');
  assert.deepEqual(block.items, [{ title: 'Cut' }, { title: 'Mix', status: 'active' }, { title: 'Export', status: 'done' }]);
});

test('checklist from a newline string with bullets', () => {
  const block = ok('{"type":"checklist","items":"- Passport\\n- Tickets\\n- [x] Charger"}');
  assert.deepEqual((block.items as Array<{ text: string }>).map(i => i.text), ['Passport', 'Tickets', 'Charger']);
});

test('form: field kinds aliased, names slugged, secret values never kept', () => {
  const block = ok('{"type":"form","fields":[{"label":"API Key","type":"password","value":"sk-123"},"Company name",{"name":"n","label":"Count","kind":"int","required":"true"}]}');
  const fields = block.fields as Array<Record<string, unknown>>;
  assert.equal(fields[0].kind, 'secret');
  assert.equal(fields[0].value, undefined);
  assert.equal(fields[1].name, 'company-name');
  assert.equal(fields[2].kind, 'number');
  assert.equal(fields[2].required, true);
});

test('approve: amount from strings with currency signs and codes', () => {
  assert.deepEqual(ok('{"type":"approve","action":"Pay","amount":"12,50 €"}').amount, { value: 12.5, currency: 'EUR' });
  assert.deepEqual(ok('{"type":"approve","action":"Pay","amount":"$5.99"}').amount, { value: 5.99, currency: 'USD' });
  assert.deepEqual(ok('{"type":"approve","action":"Pay","price":{"value":"20","currency":"chf"}}').amount, { value: 20, currency: 'CHF' });
});

test('timer: minutes shorthand becomes duration; unreadable durations fail', () => {
  assert.equal(ok('{"type":"countdown","label":"Tea","minutes":4}').duration, '4m');
  assert.equal(one('{"type":"timer","label":"x","duration":"soon-ish"}').ok, false);
});

test('progress value accepts percent', () => {
  assert.equal(ok('{"type":"progress","label":"x","value":"45%"}').value, 0.45);
  assert.equal(ok('{"type":"status","label":"x","value":0.3,"status":"working"}').status, 'running');
});

test('tabs validate nested blocks and refuse nested ask blocks', () => {
  const block = ok('{"type":"tabs","tabs":[{"label":"A","blocks":[{"type":"callout","text":"x"}]},{"label":"B","blocks":[{"type":"choice","question":"q","options":["a"]}]}]}');
  const tabs = block.tabs as Array<{ blocks: Array<{ type: string; tone?: string }> }>;
  assert.equal(tabs[0].blocks[0].type, 'callout');
  assert.equal(tabs[1].blocks[0].tone, 'warning');
});

test('ui JSON larger than the limit is refused', () => {
  const huge = `{"type":"callout","text":"${'x'.repeat(LIMITS.uiJsonBytes)}"}`;
  const result = one(huge);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------- app fences

test('app info string attributes', () => {
  assert.deepEqual(parseAppInfo(' title="Loan calc" todo=true expand permissions="microphone,camera,geolocation"'),
    { title: 'Loan calc', todo: true, expand: true, permissions: ['microphone', 'camera'] });
  assert.deepEqual(parseAppInfo(''), { todo: false, expand: false, permissions: [] });
  assert.equal(parseAppInfo("title='Mixer' todo=false").todo, false);
});

test('appHtmlOf and appTodosOf find app fences by index', () => {
  const body = `${ui('{"type":"callout","text":"x"}')}\n${F}app title="Mixer" todo\n<input type=range>\n${F}`;
  assert.equal(appHtmlOf(body, 1), '<input type=range>');
  assert.equal(appHtmlOf(body, 0), undefined);
  assert.deepEqual(appTodosOf(body).map(a => a.index), [1]);
});

test('app larger than the limit gets an error and no html', () => {
  const body = `${F}app\n${'x'.repeat(LIMITS.appHtmlBytes + 1)}\n${F}`;
  const part = parseMessage(body)[0] as Extract<Part, { kind: 'app' }>;
  assert.equal(part.error, 'app too large');
  assert.equal(part.html, '');
});

// ---------------------------------------------------------------- consumer helpers

test('uiBlocksOf returns the valid blocks with their message indexes; "todo" as written', () => {
  const body = [
    ui('{"type":"callout","text":"x"}'),
    ui('{"type":"record","mode":"audio"}'),
    ui('{"type":"choice","question":"q","options":["a"],"todo":false}'),
    ui('{"type":"timer","label":"t","duration":"PT5M"}'),
    ui('{"type":"choice"}'),
  ].join('\n');
  assert.deepEqual(uiBlocksOf(body).map(b => [b.index, b.block.type, b.block.todo]),
    [[0, 'callout', undefined], [1, 'record', undefined], [2, 'choice', false], [3, 'timer', undefined]]);
});

test('blockKey', () => {
  assert.equal(blockKey('msg_1', 2), 'b_msg_1_2');
});

test('a typical messy model answer parses into the expected parts', () => {
  const body = [
    "Here's the plan:",
    '',
    '```ui',
    "[ { type: 'steps', items: ['Script', 'Record', 'Edit'], },",
    "  { type: 'teleprompter', id: 'Intro Video', script: 'Hi!', bullets: 'Smile', due: 'PT3H' }, ]",
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[Script] --> B[Record]',
    '```',
    'Done soon.',
  ].join('\n');
  const parts = parseMessage(body);
  assert.deepEqual(kinds(parts), ['markdown', 'ui', 'ui', 'mermaid', 'markdown']);
  const blocks = uiBlocksOf(body);
  assert.deepEqual(blocks.map(b => [b.index, b.block.type]), [[0, 'steps'], [1, 'record']]);
  assert.equal(blocks[1].block.id, 'intro-video');
  assert.equal(blocks[1].block.mode, 'video');
});
