// q-r (03.11.2026), owner's rules (f) and (e) for the main AI's memory searches: knowledge.recall and knowledge.find search the
// whole memory tree unless the caller names folders (code names no part of memory), and without an embedder they say that they
// matched words, not meaning (q-r1c z4: knowledge.find's word hits said nothing about it).
// Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agent } from '../chat/harness.ts';
import { fixture } from '../context/fixture.ts';
import { memoryTools, WORDS_ONLY } from '../../../src/runtime/tools/builtin/memory.ts';
import { findTools } from '../../../src/runtime/tools/builtin/find.ts';
import type { ToolContext, ToolOutput } from '../../../src/runtime/tools/types.ts';
import type { Agent } from '../../../src/shared/model/org.ts';

const tool = (name: string) => [...memoryTools, ...findTools].find((item) => item.name === name)!;
const textOf = (out: ToolOutput) => (out.content[0] as { text: string }).text;

function world() {
  const f = fixture();
  const vera = f.org.add(agent('ag_vera', 'Vera', { role: 'Video editor' }));
  const wes = f.org.add(agent('ag_wes', 'Wes', { role: 'Web developer' }));
  const ctxOf = (who: Agent): ToolContext => ({ agent: who, runId: 'run_mem', mode: 'general', services: f.services, signal: new AbortController().signal, status: () => {} });
  return { ...f, vera, wes, ctxOf };
}

test('knowledge.recall searches the whole tree, or the folders the caller names – no folder chosen by code', async () => {
  const f = world();
  f.knowledge.memoryWrite({ folder: 'agents/ag_vera', title: 'Schnittliste Brenner', text: 'Die Schnittliste für die Kanzlei Brenner liegt beim Projekt.' });
  f.knowledge.memoryWrite({ folder: 'company/kunden', title: 'Versandregel Kanzlei Brenner', text: 'Die Kanzlei Brenner nimmt Unterlagen nur per Einschreiben an.' });
  const all = textOf(await tool('knowledge.recall').run({ query: 'Kanzlei Brenner' }, f.ctxOf(f.wes)));
  assert.match(all, /Schnittliste Brenner/, 'another agent\'s folder is part of the tree');
  assert.match(all, /Versandregel Kanzlei Brenner/);
  const named = textOf(await tool('knowledge.recall').run({ query: 'Kanzlei Brenner', in: ['memory/company/kunden'] }, f.ctxOf(f.wes)));
  assert.match(named, /Versandregel Kanzlei Brenner/);
  assert.doesNotMatch(named, /Schnittliste/, 'the folder the caller named, no other');
});

test('rule (e): without an embedder knowledge.recall and knowledge.find say they matched words', async () => {
  const f = world();
  Object.assign(f.services, { vectors: { available: () => false } });
  f.knowledge.memoryWrite({ folder: 'company/kunden', title: 'Zahlungsregel Hartwig Gießerei', text: 'Die Hartwig Gießerei bekommt Angebote nur gegen Vorkasse.' });
  const hit = textOf(await tool('knowledge.recall').run({ query: 'Hartwig Gießerei Angebot' }, f.ctxOf(f.wes)));
  assert.ok(hit.startsWith(`${WORDS_ONLY}\n- [`), hit);
  const none = textOf(await tool('knowledge.recall').run({ query: 'Segelboot Winterlager' }, f.ctxOf(f.wes)));
  assert.equal(none, `${WORDS_ONLY} It found nothing.`);
  const found = textOf(await tool('knowledge.find').run({ query: 'Hartwig Gießerei Angebot' }, f.ctxOf(f.wes)));
  assert.match(found, /^No embedder is connected: memory notes and references are matched by words, not by meaning\.\n/);
  const skills = textOf(await tool('knowledge.find').run({ query: 'Hartwig Gießerei Angebot', kinds: ['main-skill', 'product-skill'] }, f.ctxOf(f.wes)));
  assert.doesNotMatch(skills, /No embedder/, 'a search of skills only says nothing about memory');
});
