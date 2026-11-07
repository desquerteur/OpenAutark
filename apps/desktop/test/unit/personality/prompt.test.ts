// AF-006: the personality in the prompt build, end to end through the real RPC methods and the real Context – a change of
// the global personality (settings.update → settings.json) reaches the very next prompt of the same Context (no restart),
// an agent's own values (personality.setAgent → its personality.json) override the global ones field by field for it
// alone, and its role edited on its page (personality.setRole) replaces its own part of SYSTEM.md while the team's
// standard stays; a resumed native session gets the changed section through the volatile delta. Plus the value checks,
// the file rules and the presets.

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fixture, route } from '../context/fixture.ts';
import { fakeExtras, OWNER, TestClient } from '../rpc/s1-helpers.ts';
import { tempDir } from '../store/helpers.ts';
import { SettingsStore } from '../../../src/runtime/settings/service.ts';
import { parseText } from '../../../src/runtime/settings/schema.ts';
import { RpcServer } from '../../../src/runtime/rpc/server.ts';
import { HandlerTable } from '../../../src/runtime/rpc/table.ts';
import { register as system } from '../../../src/runtime/rpc/handlers/system.ts';
import { register as personality } from '../../../src/runtime/rpc/handlers/personality.ts';
import { nullLogger } from '../../../src/runtime/system/log.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import { volatileDelta } from '../../../src/runtime/agents/volatile-delta.ts';
import { personalityText } from '../../../src/runtime/personality/prompt.ts';
import { PERSONALITY_FILE, readAgentPersonality } from '../../../src/runtime/personality/store.ts';
import { agentFolder } from '../../../src/runtime/agent-core/layout.ts';
import type { AgentPersonalityInfo } from '../../../src/shared/api/methods-personality.ts';
import type { Agent } from '../../../src/shared/model/org.ts';
import {
  applyPreset, applyPresetToAgent, DEFAULT_PERSONALITY, effectivePersonality, matchingPreset, PERSONALITY_PRESETS,
} from '../../../src/shared/model/personality.ts';

const HEAD = '## My personality';
const STANDARD = '# How I work\nThis company is my own work.\n\n## My role\nVideo editor: short cuts, fast pace.\n\n## What I have here\n- This PC is my workplace.';

function setup(t: TestContext) {
  const f = fixture();
  const temp = tempDir('wf-af006-');
  const data = path.join(temp.dir, 'data');
  mkdirSync(data, { recursive: true });
  const settings = new SettingsStore({ bus: f.bus, clock: f.clock, env: { locale: 'de-DE', timezone: 'Europe/Berlin' }, dataDir: data });
  settings.update({ profile: { name: 'Alex', company: 'Acme GmbH' } });
  Object.assign(f.services, { settings, paths: { ...f.services.paths, data }, log: nullLogger });
  // The fake org of the harness has no update: the real one writes SYSTEM.md (agent-core tests); here the record is enough.
  Object.assign(f.org, { update: (id: string, patch: Partial<Agent>) => { const next = { ...f.org.require(id), ...patch }; f.org.agents.set(id, next); return next; } });
  f.org.agents.set(f.vid.id, { ...f.vid, instructions: STANDARD });
  const table = new HandlerTable();
  system(table);
  personality(table);
  const server = new RpcServer({ services: () => f.services, extras: () => fakeExtras(), table, log: nullLogger });
  const client = new TestClient(server, OWNER);
  t.after(() => { server.close(); settings.close(); temp.cleanup(); });
  const chat = f.chats.create({ agentIds: [f.vid.id, f.manager.id], createdBy: 'human' });
  /** One turn's prompt, built as the dispatcher does: the agent as it is now, the same Context every time. */
  const prompt = (agentId = f.vid.id) => {
    const parts = f.context.prompt({ agent: f.org.require(agentId), conversationId: chat.id, mode: GENERAL_MODE, route: route() });
    return { ...parts, sections: parts.sections ?? [] };
  };
  return { ...f, client, prompt, data, settings };
}

test('global: a tone changed in Settings › Personality is in the very next prompt – same Context, no restart', async (t) => {
  const f = setup(t);
  const before = f.prompt();
  assert.ok(!before.volatile.includes(HEAD), 'nothing set: no section, the prompt stays as it was');

  await f.client.call('settings.update', { personality: { tone: 'casual', address: 'informal', language: 'de', emoji: 'off', length: 'short', instructions: 'Call me Alex. Ask before you send anything in my name.' } });
  const first = f.prompt();
  for (const line of [
    '## My personality (how Alex wants me to write',
    '- Tone: casual and relaxed, like a colleague they know well.',
    '- Address: I address Alex informally (du in German, tu in French …).',
    '- Language: I answer in German, also when a message comes in another language.',
    '- Emoji: none.',
    '- Length: short – the point first, a few sentences; more only when asked.',
    'How Alex wants me to treat them, in their words:\nCall me Alex. Ask before you send anything in my name.',
  ]) assert.ok(first.volatile.includes(line), `missing: ${line}\n${first.volatile}`);
  assert.ok(first.sections.some((section) => section.name === 'personality'), 'its own named section of the volatile prompt');
  assert.equal(first.stable, before.stable, 'the stable prefix (and its provider cache) is untouched');

  await f.client.call('settings.update', { personality: { tone: 'formal' } });
  const second = f.prompt();
  assert.ok(second.volatile.includes('- Tone: formal and polite.'), second.volatile);
  assert.ok(!second.volatile.includes('casual and relaxed'), 'the old tone is gone at the next answer');
  assert.ok(second.volatile.includes('- Emoji: none.'), 'the other values stay');

  const file = parseText(readFileSync(path.join(f.data, 'settings.json'), 'utf8')).data as { personality: Record<string, string> };
  assert.equal(file.personality.tone, 'formal', 'settings.json holds it, so the AI and a hand edit see the same value');

  // A resumed native session gets only what changed: the new personality section, not the unchanged ones again.
  const sent = volatileDelta(first.sections, undefined).sections;
  const delta = volatileDelta(second.sections, sent);
  assert.ok(delta.text.includes('- Tone: formal and polite.'), delta.text);
  assert.ok(!delta.text.includes('## This chat'), 'unchanged sections are only named');
});

test('agent over global: its own values win field by field, for it alone, from its next answer on', async (t) => {
  const f = setup(t);
  await f.client.call('settings.update', { personality: { tone: 'casual', emoji: 'on', instructions: 'Call me Alex.' } });
  const info = await f.client.call<AgentPersonalityInfo>('personality.setAgent', { agentId: f.vid.id, personality: { tone: 'formal', length: 'detailed', instructions: 'Always start with a one-line summary.' } });
  assert.deepEqual(info.own, { tone: 'formal', length: 'detailed', instructions: 'Always start with a one-line summary.' });

  const vic = f.prompt(f.vid.id).volatile;
  for (const line of [
    `agents/${f.vid.id}/${PERSONALITY_FILE} go first`,
    '- Tone: formal and polite (set for me).',
    '- Emoji: now and then, where one fits.', // the global value where it has none of its own
    '- Length: detailed – thorough, with background and reasons (set for me).',
    'How Alex wants me to treat them, in their words:\nCall me Alex.',
    'Set for me alone (where it differs from the above, this wins):\nAlways start with a one-line summary.',
  ]) assert.ok(vic.includes(line), `missing: ${line}\n${vic}`);
  assert.ok(!vic.includes('casual and relaxed'));
  assert.equal(info.preview, f.prompt(f.vid.id).sections.find((section) => section.name === 'personality')?.text, 'the page shows what the next turn reads');

  const mia = f.prompt(f.manager.id).volatile;
  assert.ok(mia.includes('- Tone: casual and relaxed, like a colleague they know well.'), 'another agent keeps the global tone');
  assert.ok(!mia.includes('Set for me alone') && !mia.includes('(set for me)'));

  const file = path.join(agentFolder(f.data, f.vid.id), PERSONALITY_FILE);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { tone: 'formal', length: 'detailed', instructions: 'Always start with a one-line summary.' });

  // A hand edit of the file applies at the next answer too; an invalid value is dropped, never a broken turn.
  writeFileSync(file, JSON.stringify({ tone: 'grumpy', emoji: 'off' }));
  const edited = f.prompt(f.vid.id).volatile;
  assert.ok(edited.includes('- Tone: casual and relaxed') && edited.includes('- Emoji: none (set for me).'), edited);
  writeFileSync(file, '{ not json');
  assert.deepEqual(readAgentPersonality(f.data, f.vid.id), {});
  assert.ok(f.prompt(f.vid.id).volatile.includes('- Tone: casual and relaxed'));

  // "Like everyone": {} removes the file, the agent follows the global personality again.
  await f.client.call('personality.setAgent', { agentId: f.vid.id, personality: {} });
  assert.equal(existsSync(file), false);
  assert.ok(f.prompt(f.vid.id).volatile.includes('- Tone: casual and relaxed'));
});

test('role edited on the agent page: its own part of SYSTEM.md is replaced, the team standard stays, the next prompt has it', async (t) => {
  const f = setup(t);
  const info = await f.client.call<AgentPersonalityInfo>('personality.agent', { agentId: f.vid.id });
  assert.equal(info.standard, true);
  assert.equal(info.role, '## My role\nVideo editor: short cuts, fast pace.\n\n## What I have here\n- This PC is my workplace.');
  assert.ok(f.prompt().stable.includes('short cuts, fast pace'));

  const role = '## My role\nVideo editor: long documentaries, calm cuts.\n\n## What I have here\n- This PC is my workplace.';
  const agent = await f.client.call<Agent>('personality.setRole', { agentId: f.vid.id, role, base: info.instructions });
  assert.equal(agent.instructions, `# How I work\nThis company is my own work.\n\n${role}`);
  const stable = f.prompt().stable;
  assert.ok(stable.includes('long documentaries, calm cuts') && !stable.includes('short cuts, fast pace'), 'the next prompt reads the new role');
  assert.ok(stable.includes('# How I work\nThis company is my own work.'), 'the team standard above the role stays');

  // Without the heading the role heading is put back; an edit that started from an older text is a conflict.
  const plain = await f.client.call<Agent>('personality.setRole', { agentId: f.vid.id, role: 'Video editor: trailers.', base: agent.instructions });
  assert.equal(plain.instructions, '# How I work\nThis company is my own work.\n\n## My role\nVideo editor: trailers.');
  await assert.rejects(f.client.call('personality.setRole', { agentId: f.vid.id, role: 'Video editor: ads.', base: info.instructions }), (error: { code?: string }) => error.code === 'conflict');
  await assert.rejects(f.client.call('personality.setRole', { agentId: f.vid.id, role: '   ' }), (error: { code?: string }) => error.code === 'bad_request');
});

test('values are checked: unknown options, keys and over-long texts are refused, settings and the agent file alike', async (t) => {
  const f = setup(t);
  const refused = (error: { code?: string }) => error.code === 'bad_request';
  await assert.rejects(f.client.call('settings.update', { personality: { tone: 'grumpy' } }), refused);
  await assert.rejects(f.client.call('settings.update', { personality: { language: 'German' } }), refused);
  await assert.rejects(f.client.call('settings.update', { personality: { mood: 'happy' } }), refused);
  await assert.rejects(f.client.call('settings.update', { personality: { instructions: 'x'.repeat(1501) } }), refused);
  await assert.rejects(f.client.call('personality.setAgent', { agentId: f.vid.id, personality: { emoji: 'maybe' } }), refused);
  await assert.rejects(f.client.call('personality.setAgent', { agentId: f.vid.id, personality: { mood: 'happy' } }), refused);
  assert.ok(!f.prompt().volatile.includes(HEAD), 'nothing refused reached the prompt');
  assert.deepEqual(f.settings.get().personality, DEFAULT_PERSONALITY, 'the defaults are a whole section in settings.json');
});

test('presets: a preset sets the style, keeps the language and never overwrites the person\'s own words', () => {
  const brief = PERSONALITY_PRESETS.find((item) => item.id === 'brief')!;
  const coach = PERSONALITY_PRESETS.find((item) => item.id === 'coach')!;
  const own = { ...DEFAULT_PERSONALITY, language: 'de', instructions: 'Call me Kim.' };
  const picked = applyPreset(own, coach);
  assert.equal(picked.tone, 'friendly');
  assert.equal(picked.language, 'de');
  assert.equal(picked.instructions, 'Call me Kim.', 'own words stay');
  assert.equal(applyPreset(DEFAULT_PERSONALITY, coach).instructions, coach.instructions, 'an empty text takes the preset\'s');
  assert.equal(applyPreset(applyPreset(DEFAULT_PERSONALITY, coach), brief).instructions, '', 'another preset\'s text may go');
  assert.equal(matchingPreset(applyPreset(own, brief))?.id, 'brief');
  const agent = applyPresetToAgent({ tone: 'playful', language: 'en' }, brief);
  assert.deepEqual(agent, { tone: 'factual', language: 'en', emoji: 'off', length: 'short' });
  assert.deepEqual(applyPresetToAgent(agent, PERSONALITY_PRESETS[0]), { language: 'en' }, 'Standard: the style follows everyone again');
  assert.equal(personalityText({ name: '', agentId: 'ag_x', global: DEFAULT_PERSONALITY }), '', 'nothing set: no section');
  assert.ok(personalityText({ name: '', agentId: 'ag_x', global: { tone: 'direct' } }).includes('how the person wants me to write'));
  assert.equal(effectivePersonality({ tone: 'casual' }, { tone: 'auto' }).values.tone, 'casual', '"auto" of an agent says nothing');
});
