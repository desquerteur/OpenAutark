// End-to-end (O8): hiring, delegation and scale of the org over the real headless runtime (built
// app/runtime-cli.mjs --fake, temp profile, real WebSocket RPC on 127.0.0.1 – no network).
// Covers:
//  1. First run: exactly one Manager – no manager, no space, a root of the org tree – and its chat.
//  2. Hiring: the Manager's agents.create {template:'secretary'} runs at once (agents may do everything – no
//     approval to-do); the Secretary exists once,
//     reports to the person (no manager, her own root) and works in the new Private space – her
//     own system prompt says so.
//  3. Delegation: the Manager gives a web developer a job (agents.delegate into a work chat); the
//     developer finishes it with tasks.complete in its handoff turn; the Manager is woken with
//     reason 'child' in that chat.
//  4. Scale: 30 agents in 3 spaces under 3 managers (and the Manager above them) – org depth and
//     counts, the identity's report list cap (15 + "and N more"), the size of agents.list for a
//     model, the setup-facts cap, RPC and turn response times, and that hiring costs no turns
//     (only the four agents asked run, once each).
// Fake engine directives (src/runtime/engines/fake.ts): [[tool:…]], [[prompt:<text>]] (lines of
// the agent's system prompt), [[size:<tool> {…}]] (only the output size) and "$task" (the turn's
// current task). Acceptance: the whole file passes in under 60 s.
// Run: npm run build && node --test test/e2e/runtime-org.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ask, startRuntime, waitForNew } from './lib/runtime-client.mjs';
import { MAX_TEXT_CHARS } from '../../src/runtime/tools/outputs.ts';
import { SETUP_CAP } from '../../src/runtime/context/setup-facts.ts';

const FILE_STARTED = Date.now();
const FILE_LIMIT_MS = 60_000;
const RPC_MS = 1500; // one read RPC with 30 agents
const TURN_MS = 20_000; // one fake turn, four in parallel
const HIRE_MS = 15_000; // 3 spaces and 29 hires through the RPC
const ROLES = ['Researcher', 'Writer', 'Designer', 'Developer', 'Analyst', 'Support'];

const finalFrom = (chatId, agentId, pattern) => (message) =>
  message.conversationId === chatId && message.authorId === agentId && message.state === 'final' && pattern.test(message.body);

/** The JSON a tool returned in a fake-engine answer ("<tool> → {…}", the last such part). The fake engine shows
 * the first 2000 characters of a result: a hire's (B-047) ends with the new agent's SYSTEM.md, so a cut one is
 * read up to that last field. */
function toolResult(body, tool) {
  const part = body.split('\n\n').findLast((entry) => entry.startsWith(`${tool} → `));
  assert.ok(part, `${tool} ran: ${body.slice(0, 600)}`);
  const text = part.slice(`${tool} → `.length);
  const cut = text.endsWith('\n[truncated]') ? text.lastIndexOf(',"system":') : -1;
  return JSON.parse(cut > 0 ? `${text.slice(0, cut)}}` : text);
}

/** The system-prompt lines a fake-engine answer quoted with [[prompt:…]]. */
const promptLines = (body) => body.split('\n').filter((line) => line.startsWith('prompt → ')).map((line) => line.slice('prompt → '.length));

/** JSON for a [[tool:…]] directive whose strings carry another agent's directive: [, ] and $ escaped
 * (inside strings only – the args have no arrays), so this turn neither runs it nor fills in "$task". */
const hidden = (args) => JSON.stringify(args).replace(/[[\]$]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** A waiter that never becomes an unhandled rejection when the test fails before awaiting it. */
const later = (promise) => { promise.catch(() => undefined); return promise; };

async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

test('hiring and delegation: the secretary at once, delegated work comes back to the Manager', { timeout: FILE_LIMIT_MS }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  await client.call('events.subscribe', { topics: ['chats', 'tasks', 'org'] });

  // 1. First run: one Manager outside every space and chain, with its first chat.
  const agents = await client.call('agents.list');
  assert.equal(agents.length, 1, 'the first run seeds exactly one agent');
  const [manager] = agents;
  assert.equal(manager.template, 'manager');
  assert.equal(manager.managerId, undefined, 'the Manager reports to the person');
  assert.equal(manager.spaceId, undefined, 'the Manager spans all areas');
  assert.deepEqual(await client.call('spaces.list'), [], 'no space before the first hire of an area');
  assert.deepEqual((await client.call('agents.org')).map((node) => [node.agent.id, node.reports.length]), [[manager.id, 0]]);
  const keys = (await client.call('agents.templates')).map((template) => template.key);
  assert.ok(keys.includes('secretary') && keys.includes('web-developer'), 'both templates can be hired');
  const first = (await client.call('chats.list')).find((chat) => chat.members.some((member) => member.memberId === manager.id));
  assert.ok(first, 'the Manager\'s first chat');
  await client.call('events.subscribe', { topics: [`chat:${first.id}`, `runs:${manager.id}`] });

  // 2. Agents may do everything: the hire runs at once (no approval to-do, no permission mode).
  const hired = later(waitForNew(client, 'message.updated', finalFrom(first.id, manager.id, /agents\.create → /), 30_000));
  await client.call('messages.send', { conversationId: first.id, body: 'Hire my private assistant [[tool:agents.create {"template":"secretary"}]]' });
  const created = toolResult((await hired).body, 'agents.create');
  assert.equal(created.ok, true, JSON.stringify(created));

  const secretary = await client.call('agents.get', { id: created.agentId });
  assert.equal(secretary.template, 'secretary');
  assert.equal(secretary.managerId, undefined, 'she reports to the person, not to the Manager');
  assert.equal((await client.call('agents.list')).filter((agent) => agent.template === 'secretary').length, 1, 'one secretary');
  const privateSpace = (await client.call('spaces.list')).find((space) => space.id === secretary.spaceId);
  assert.deepEqual([privateSpace?.kind, privateSpace?.name, created.space], ['private', 'Private', 'Private'], 'she works in the Private space');
  const roots = await client.call('agents.org');
  assert.deepEqual(roots.map((node) => node.agent.id).sort(), [manager.id, secretary.id].sort(), 'two roots: the Manager and the Secretary');
  assert.equal(roots.find((node) => node.agent.id === manager.id).reports.length, 0, 'she is not in the Manager\'s branch');

  const errands = await client.call('chats.create', { title: 'Errands', agentIds: [secretary.id] });
  await client.call('events.subscribe', { topics: [`chat:${errands.id}`] });
  const own = await ask(client, errands.id, secretary.id, 'Who do you work for? [[prompt:I report directly]] [[prompt:My area]]', { pattern: /prompt → / });
  const told = promptLines(own.message.body);
  assert.ok(told.some((line) => line.startsWith('I report directly to ')), `her prompt names no manager: ${told.join(' | ')}`);
  assert.ok(told.includes('My area: Private.'), told.join(' | '));

  // 3. Delegation: a web developer under the Manager gets a job in a work chat and finishes it.
  const dev = await client.call('agents.create', { template: 'web-developer', managerId: manager.id });
  assert.equal(dev.managerId, manager.id);
  assert.equal((await client.call('spaces.list')).find((space) => space.id === dev.spaceId)?.kind, 'company', 'the company area');
  // A fresh chat for the brief (the first chat holds the hire directive, which a renewed session
  // would run again) and a work chat the developer joins (it never sees the brief's directive).
  const brief = await client.call('chats.create', { title: 'Website', agentIds: [manager.id] });
  const work = await client.call('chats.create', { title: 'Landing page', agentIds: [manager.id] });
  await client.call('events.subscribe', { topics: [`chat:${brief.id}`, `chat:${work.id}`, `runs:${dev.id}`] });

  const complete = '[[tool:tasks.complete {"taskId":"$task","summary":"Landing page built","evidence":[{"kind":"note","label":"Landing page checked in the preview"}]}]]';
  const job = { to: dev.id, title: 'Build the landing page', chatId: work.id, goal: `Build the landing page ${complete}` };
  // The checkpoint quotes the first 300 characters of the latest request to the developer: the
  // brief comes first, so no complete directive of the Manager's own call reaches it.
  const text = 'The landing page presents the product on one screen: a headline, three short benefits, the pricing table and a sign-up '
    + 'form. Keep it to a single page, use the brand colours, make it work on phones and check it in the preview before you report '
    + 'back with the file you changed. Hand this to the web developer as one bounded job.';
  assert.ok(text.length > 300);
  const doneTask = later(waitForNew(client, 'task.upserted', (task) => task.title === job.title && task.status === 'done', 30_000));
  const childRun = later(waitForNew(client, 'run.upserted', (run) => run.agentId === manager.id && run.trigger === 'child' && run.status === 'done', 30_000));
  const sent = await ask(client, brief.id, manager.id, `${text} [[tool:agents.delegate ${hidden(job)}]]`, { pattern: /agents\.delegate → / });
  const delegated = toolResult(sent.message.body, 'agents.delegate');
  assert.deepEqual([delegated.ok, delegated.to], [true, dev.id], JSON.stringify(delegated));

  const done = await doneTask;
  assert.equal(done.id, delegated.taskId);
  assert.deepEqual([done.assigneeId, done.createdBy, done.conversationId, done.parentId], [dev.id, manager.id, work.id, undefined]);
  assert.equal(done.result?.summary, 'Landing page built');
  assert.equal(done.result?.verification, 'claimed_by_agent');
  const runs = client.events.filter((frame) => frame.event === 'run.upserted' && frame.data.agentId === dev.id).map((frame) => frame.data);
  assert.ok(runs.some((run) => run.trigger === 'handoff' && run.taskId === done.id), 'the developer worked on it in its handoff turn');
  assert.ok((await client.call('chats.get', { id: work.id })).members.some((member) => member.memberId === dev.id && !member.leftAt), 'the developer joined the work chat');

  const woken = await childRun;
  assert.deepEqual([woken.taskId, woken.conversationId], [done.id, work.id], 'the Manager hears back in the work chat');
  const tree = await client.call('agents.org');
  assert.deepEqual(tree.find((node) => node.agent.id === manager.id).reports.map((node) => node.agent.id), [dev.id]);
  assert.equal((await client.call('todos.list')).filter((task) => task.widget?.type === 'approve').length, 0, 'no approval card anywhere');
});

test('scale: 30 agents in 3 spaces under 3 managers', { timeout: FILE_LIMIT_MS }, async (t) => {
  const runtime = await startRuntime();
  t.after(() => runtime.stop());
  const { client } = runtime;
  const [seed] = await client.call('agents.list');
  assert.equal(seed?.template, 'manager');
  const timings = {};
  // Printed even when an assertion below fails (the timings are what a failure needs).
  t.after(() => t.diagnostic(`O8 timings ${JSON.stringify(timings)}`));

  // The person builds the org through the RPC: 3 spaces, 3 managers under the Manager, 26 reports
  // (one of them leads a report of its own).
  const hiring = await timed(async () => {
    const spaces = {};
    for (const [name, kind] of [['Acme', 'company'], ['Studio', 'brand'], ['Lab', 'custom']]) spaces[name] = await client.call('spaces.save', { name, kind });
    const hire = (name, role, managerId, space, mode) => client.call('agents.create', { name, role, managerId, spaceId: spaces[space].id, ...(mode ? { mode } : {}) });
    const lead = {};
    for (const [name, space] of [['Ada', 'Acme'], ['Bea', 'Studio'], ['Cy', 'Lab']]) lead[name] = await hire(name, `${space} lead`, seed.id, space, 'manager');
    const team = (prefix, count, managerId, space, pad) => Array.from({ length: count }, (_, index) => [`${prefix} ${String(index + 1).padStart(pad, '0')}`, ROLES[index % ROLES.length], managerId, space]);
    const acme = []; for (const args of team('Acme agent', 18, lead.Ada.id, 'Acme', 2)) acme.push(await hire(...args));
    const studio = []; for (const args of team('Studio agent', 4, lead.Bea.id, 'Studio', 1)) studio.push(await hire(...args));
    const deep = await hire('Studio agent 5', 'Editor', studio[0].id, 'Studio');
    const lab = []; for (const args of team('Lab agent', 3, lead.Cy.id, 'Lab', 1)) lab.push(await hire(...args));
    return { spaces, lead, acme, studio, deep, lab };
  });
  timings.hire = hiring.ms;
  assert.ok(hiring.ms < HIRE_MS, `3 spaces and 29 hires took ${hiring.ms} ms`);
  const { spaces, lead, acme, studio, deep, lab } = hiring.value;

  // Reads with 30 agents stay fast.
  const reads = {};
  for (const method of ['agents.list', 'agents.org', 'spaces.list', 'chats.list']) {
    const { value, ms } = await timed(() => client.call(method));
    reads[method] = value;
    timings[method] = ms;
    assert.ok(ms < RPC_MS, `${method} took ${ms} ms`);
  }
  const all = reads['agents.list'];
  assert.equal(all.length, 30, '30 active agents');
  timings.agentsListBytes = JSON.stringify(all).length;
  assert.equal(reads['spaces.list'].length, 3);
  const perSpace = (space) => all.filter((agent) => agent.spaceId === space?.id).length;
  assert.deepEqual([perSpace(spaces.Acme), perSpace(spaces.Studio), perSpace(spaces.Lab), all.filter((agent) => !agent.spaceId).length], [19, 6, 4, 1]);

  // Org depth and counts: the Manager → 3 managers → 25 reports → 1 report of a report.
  const tree = reads['agents.org'];
  const levels = [];
  const walk = (nodes, depth) => { for (const node of nodes) { levels[depth] = (levels[depth] ?? 0) + 1; walk(node.reports, depth + 1); } };
  walk(tree, 0);
  assert.deepEqual(levels, [1, 3, 25, 1], 'four levels, 30 agents');
  assert.equal(tree[0].agent.id, seed.id, 'one root: the Manager');
  const node = (id, nodes = tree) => { for (const item of nodes) { if (item.agent.id === id) return item; const found = node(id, item.reports); if (found) return found; } return undefined; };
  assert.deepEqual([seed, lead.Ada, lead.Bea, lead.Cy, studio[0]].map((agent) => node(agent.id).reports.length), [3, 18, 4, 3, 1]);
  assert.equal(node(deep.id).reports.length, 0);

  // Four turns at once (bounded): identity, agents.list size, setup facts.
  const chatOf = {};
  chatOf[seed.id] = (reads['chats.list'].find((chat) => chat.members.some((member) => member.memberId === seed.id)) ?? await client.call('chats.create', { title: 'Manager', agentIds: [seed.id] })).id;
  for (const agent of [lead.Ada, lead.Bea, lead.Cy]) chatOf[agent.id] = (await client.call('chats.create', { title: `${agent.name} 1:1`, agentIds: [agent.id] })).id;
  await client.call('events.subscribe', { topics: Object.values(chatOf).map((id) => `chat:${id}`) });
  const turn = (agent, body, pattern) => ask(client, chatOf[agent.id], agent.id, body, { pattern, timeoutMs: TURN_MS });
  const together = await timed(() => Promise.all([
    turn(seed, '[[tool:app.status {}]] [[prompt:- Agents:]] [[prompt:My direct reports]]', /app\.status → /),
    turn(lead.Ada, '[[prompt:My direct reports]] [[size:agents.list {}]]', /agents\.list size → /),
    turn(lead.Bea, '[[prompt:My direct reports]] [[prompt:I report to]]', /prompt → /),
    turn(lead.Cy, '[[prompt:My direct reports]]', /prompt → /),
  ]));
  const [seedTurn, adaTurn, beaTurn, cyTurn] = together.value;
  Object.assign(timings, { turns: together.ms, seedTurn: seedTurn.ms, adaTurn: adaTurn.ms, beaTurn: beaTurn.ms, cyTurn: cyTurn.ms });
  for (const [name, ms] of [['seed', seedTurn.ms], ['Ada', adaTurn.ms], ['Bea', beaTurn.ms], ['Cy', cyTurn.ms]]) assert.ok(ms < TURN_MS, `${name}'s turn took ${ms} ms`);

  // Identity: at most 15 reports by name, then "and N more".
  const reportsLine = (body) => promptLines(body).filter((line) => line.startsWith('My direct reports: '));
  const listed = (agents) => [...agents].sort((a, b) => a.name.localeCompare(b.name)).map((agent) => `${agent.name} (${agent.role})`);
  assert.deepEqual(reportsLine(adaTurn.message.body), [`My direct reports: ${listed(acme).slice(0, 15).join(', ')} and 3 more.`]);
  assert.deepEqual(reportsLine(beaTurn.message.body), [`My direct reports: ${listed(studio).join(', ')}.`]);
  assert.deepEqual(reportsLine(cyTurn.message.body), [`My direct reports: ${listed(lab).join(', ')}.`]);
  assert.deepEqual(reportsLine(seedTurn.message.body), [`My direct reports: ${listed([lead.Ada, lead.Bea, lead.Cy]).join(', ')}.`]);
  assert.ok(promptLines(beaTurn.message.body).includes(`I report to ${seed.name} (${seed.role}).`));

  // agents.list as a model gets it: all 30, whole (never cut into a file).
  const size = toolResult(adaTurn.message.body, 'agents.list size');
  timings.agentsListToolChars = size.chars;
  assert.deepEqual([size.items, size.truncated, size.error], [30, false, false], JSON.stringify(size));
  assert.ok(size.chars < MAX_TEXT_CHARS, `agents.list is ${size.chars} characters for a model`);

  // Setup facts: within the cap, the real counts per space – in app.status and in the prompt.
  const setupPart = seedTurn.message.body.split('\n\n').find((part) => part.startsWith('app.status → '));
  const setup = setupPart.slice('app.status → '.length);
  timings.setupChars = setup.length;
  assert.ok(setup.length <= SETUP_CAP, `setup facts are ${setup.length} characters`);
  const setupLines = setup.split('\n');
  assert.equal(setupLines[0], '## App status (live)');
  assert.ok(setupLines.includes('- Spaces: Acme (company), Studio (brand), Lab (custom)'), setup);
  const agentsLine = '- Agents: 30 active – Acme 19 (manager Ada) · Studio 6 (managers Bea, Studio agent 1) · Lab 4 (manager Cy) · no space 1 (manager Manager)';
  assert.ok(setupLines.includes(agentsLine), setup);
  assert.ok(promptLines(seedTurn.message.body).includes(agentsLine), 'the Manager\'s prompt carries the same facts');

  // Bounded: hiring 29 agents started no turn – only the four agents asked ran, once each.
  await sleep(1000);
  const asked = new Set([seed.id, lead.Ada.id, lead.Bea.id, lead.Cy.id]);
  const runs = await timed(() => Promise.all(all.map(async (agent) => [agent, await client.call('agents.runs', { id: agent.id })])));
  timings.runsOf30 = runs.ms;
  for (const [agent, list] of runs.value) {
    if (asked.has(agent.id)) assert.deepEqual(list.map((run) => [run.trigger, run.status]), [['message', 'done']], `${agent.name} ran once`);
    else assert.equal(list.length, 0, `${agent.name} never ran`);
  }
});

test('the org E2E stays under 60 s', () => {
  const elapsed = Date.now() - FILE_STARTED;
  assert.ok(elapsed < FILE_LIMIT_MS, `the file took ${elapsed} ms`);
});
