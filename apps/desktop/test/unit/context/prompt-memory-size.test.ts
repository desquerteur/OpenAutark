// The first prompt does not grow with memory (owner 01.11.2026, B-066 wishes): the main AI's stable and volatile prompt and
// the subconscious's first system and step prompt are the same at 0, 100 and 2,000 real memory files (every second with a
// description, a _folder.md in every folder), and no title or description of them is in any of them. A pinned file shows
// its title and text, never its description.
// Before the wishes, measured by hand with a one-off script (03.11.2026, manager mode, the same at 0, 100
// and 2,000 files): main stable 11,457 / volatile 1,389 characters (codex), 11,232 / 1,393 (claude); subconscious system
// 7,857, step 804, schema 576.
// Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESOURCES, fixture, route } from './fixture.ts';
import { PromptTemplates } from '../../../src/runtime/context/templates.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { runFlow } from '../../../src/runtime/subconscious/flow.ts';
import type { StructuredRunner } from '../../../src/runtime/decision/types.ts';

const TITLE = 'Kolibri';
const DESCRIPTION = 'Wendeltreppe';

function world(t: { after(fn: () => void): void }) {
  const f = fixture();
  f.services.prompts = new PromptTemplates(() => path.join(RESOURCES, 'prompts'));
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  const root = f.knowledge.memoryRoot;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folders = ['company', 'company/kunden', 'branches/sp_co', `agents/${f.vid.id}`, `chats/${chat.id}`];
  for (const folder of folders) {
    mkdirSync(path.join(root, folder), { recursive: true });
    writeFileSync(path.join(root, folder, '_folder.md'), `What ${folder} holds.\n`);
  }
  let written = 0;
  /** Real memory files up to `count`, none pinned. */
  const grow = (count: number) => {
    for (; written < count; written++) {
      const description = written % 2 ? `description: ${DESCRIPTION} ${written}, when this note helps.\n` : '';
      writeFileSync(path.join(root, folders[written % folders.length], `note-${written}.md`), `---\ntitle: ${TITLE} ${written}\n${description}kind: fact\nupdated: 2026-10-01T00:00:00.000Z\n---\n\nText ${written} of a note.\n`);
    }
  };
  /** The main AI's prompt and the subconscious's first request, with a brain that records it and ends. */
  const first = async () => {
    const { stable, volatile } = f.context.prompt({ agent: f.vid, conversationId: chat.id, mode: GENERAL_MODE, route: route() });
    const calls: Array<Parameters<StructuredRunner>[0]> = [];
    const decision: StructuredRunner = async (call) => { calls.push(call); return { text: '', structured: { tool: 'done', args: '{}' }, by: 'fake' }; };
    await runFlow(f.services, { decision }, { kind: 'after-turn', agent: f.vid, conversationId: chat.id, thread: chat.id, context: 'The person: Wer ist unser Steuerberater?' });
    return { stable, volatile, system: calls[0].system, step: calls[0].prompt };
  };
  return { f, root, grow, first };
}

const bytes = (texts: Record<string, string>) => Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, Buffer.byteLength(text)]));

test('the first prompt of the main AI and of the subconscious is the same at 0, 100 and 2,000 memory files and names none of them', async (t) => {
  const w = world(t);
  const sizes: Array<Record<string, number>> = [];
  for (const count of [0, 100, 2000]) {
    w.grow(count);
    const texts = await w.first();
    assert.ok(texts.system && texts.step, 'the subconscious ran');
    sizes.push(bytes(texts));
    for (const [name, text] of Object.entries(texts)) {
      assert.ok(!text.includes(TITLE) && !text.includes(DESCRIPTION), `${name} at ${count} files names no memory file`);
    }
  }
  assert.deepEqual(sizes[1], sizes[0], '100 files');
  assert.deepEqual(sizes[2], sizes[0], '2,000 files');
});

test('a pinned file with a description: its title and text are in the volatile prompt, its description is not', async (t) => {
  const w = world(t);
  mkdirSync(path.join(w.root, 'company', 'pinned'), { recursive: true });
  writeFileSync(path.join(w.root, 'company', 'pinned', 'kanzlei.md'), `---\ntitle: Kanzlei Weber\ndescription: ${DESCRIPTION}, when the tax office writes.\n---\n\nUnser Steuerberater ist Jonas Weber in Bonn.\n`);
  const texts = await w.first();
  assert.ok(texts.volatile.includes('Kanzlei Weber') && texts.volatile.includes('Unser Steuerberater ist Jonas Weber in Bonn.'), texts.volatile);
  for (const [name, text] of Object.entries(texts)) assert.ok(!text.includes(DESCRIPTION), `${name} holds no description`);
});
