// B-059 (#25): learning must not churn the stable prompt – the skills line names no count, so a new (or retired)
// skill leaves the stable text byte-identical (the native session key stays); only an empty ↔ non-empty index
// changes it. Owns: these assertions only. Never: real models, network or timers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, route, VIDEO_MODE } from './fixture.ts';
import type { SkillInfo } from '../../../src/shared/model/knowledge.ts';

const skill = (name: string): SkillInfo => ({ name, description: `${name} – how and when.`, source: 'agent', ownerAgentId: 'ag_vid', path: `/skills/${name}`, modes: [], updatedAt: 0 });

test('a new skill leaves the stable prompt byte-identical; the line names no number', () => {
  const index: SkillInfo[] = [skill('cut-trailer')];
  const f = fixture({ skills: index });
  const chat = f.chats.create({ agentIds: [f.vid.id], createdBy: 'human' });
  const stable = () => f.context.prompt({ agent: f.vid, conversationId: chat.id, mode: VIDEO_MODE, route: route() }).stable;
  const before = stable();
  assert.ok(/## Skills\n[\s\S]*Skills exist for most kinds of work/.test(before), before);
  assert.ok(!/## Skills\n\d/.test(before));
  index.push(skill('export-preset'), skill('upload-youtube'));
  assert.equal(stable(), before, 'two more skills, the same stable text');
  index.length = 0;
  assert.ok(!stable().includes('## Skills'), 'an empty index leaves the section out');
});
