// Wave 3: the stable prompt takes the agent's instructions from its agent core (SYSTEM.md) and lists its Main Skills
// in their own section between the instructions and the general skills index; without an agent core (older
// fakes, a failing core) it uses the agent row as before. Owns: these assertions only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route } from '../context/fixture.ts';
import { GENERAL_MODE } from '../../../src/runtime/modes/service.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';

const main: SkillInfo = { name: 'cut-style', description: 'How we cut: tight, no fades.', source: 'agent', ownerAgentId: 'ag_vid', path: '/x', modes: [], updatedAt: 0, main: true };
const indexed: SkillInfo = { name: 'remotion-video', description: 'Render videos with Remotion.', source: 'builtin', path: '/y', modes: [], updatedAt: 0 };

test('the stable prompt: SYSTEM.md as "My instructions", then "My main skills", then the index', () => {
  const f = fixture({ skills: [indexed] });
  Object.assign(f.services, {
    agentCore: { instructions: () => 'From SYSTEM.md: keep cuts short.', mainSkills: () => [main] },
  });
  const stable = f.context.prompt({ agent: f.vid, mode: GENERAL_MODE, route: route() }).stable;
  const own = stable.indexOf('## My instructions\nFrom SYSTEM.md: keep cuts short.');
  const mainAt = stable.indexOf('## My main skills');
  const index = stable.indexOf('## Skills');
  assert.ok(own > 0 && mainAt > own && index > mainAt, stable.slice(-800));
  assert.ok(stable.includes('- cut-style – How we cut: tight, no fades.'));
  assert.ok(!stable.includes('Prefer short cuts'), 'the row text is not used while the file is');
});

test('without an agent core, or when it fails, the agent row is used and no main section appears', () => {
  const f = fixture({ skills: [indexed] });
  const plain = f.context.prompt({ agent: f.vid, mode: GENERAL_MODE, route: route() }).stable;
  assert.ok(plain.includes('## My instructions\nPrefer short cuts.'));
  assert.ok(!plain.includes('## My main skills'));
  Object.assign(f.services, { agentCore: { instructions: () => { throw new Error('disk'); }, mainSkills: () => { throw new Error('disk'); } } });
  const failing = f.context.prompt({ agent: f.vid, mode: GENERAL_MODE, route: route() }).stable;
  assert.ok(failing.includes('## My instructions\nPrefer short cuts.'));
  assert.ok(failing.includes('secret://sec_pw'), 'the instructions are still redacted');
  assert.ok(!failing.includes('## My main skills'));
});
