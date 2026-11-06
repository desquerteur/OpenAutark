// B-055 Q3: `wf feedback setup` on a temp data dir – keys made once (kept on a second run, new with --rotate), the
// private key and the service account in the vault where no agent may use them, receiver.json written from source
// (not by a packaged app), the rules in the answer, no key in the answer or the log; then the wf client itself:
// what `wf feedback setup | receive | status` call and print, and their argument checks.
// Owns: these assertions. Never: contacts Google or the user's real data.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FeedbackService } from '../../../src/runtime/feedback/service.ts';
import { RECEIVER_KEY_ID, SERVICE_ACCOUNT_ID, SETUP_KEY } from '../../../src/runtime/feedback/inbox.ts';
import { readReceiver } from '../../../src/runtime/feedback/receiver.ts';
import { publicKeyOf } from '../../../src/runtime/feedback/seal.ts';
import { SYSTEM_ID } from '../../../src/shared/ids.ts';
import type { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { KvRepo } from '../../../src/runtime/store/kv.ts';
import { fakeRuntime, wf } from '../cli/fake-runtime.ts';
import { API_KEY, PROJECT, feedbackEnv, serviceAccount, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });

function prepared() {
  const env = feedbackEnv();
  envs.push(env);
  const account = serviceAccount();
  const file = path.join(env.data, 'service-account.json');
  writeFileSync(file, account.text);
  const feedback = new FeedbackService({ services: () => env.s });
  return { env, account, file, feedback, input: { project: PROJECT, apiKey: API_KEY, serviceAccountPath: file } };
}

test('setup: keys into the vault (no agent may use them), receiver.json from source, the rules; a second run keeps the key', async () => {
  const { env, account, feedback, input } = prepared();
  const first = await feedback.setup(input);
  assert.equal(first.createdKey, true);
  assert.equal(first.receiverFile, path.join(env.resources, 'feedback', 'receiver.json'));
  assert.deepEqual(JSON.parse(readFileSync(first.receiverFile!, 'utf8')), { publicKey: first.publicKey, project: PROJECT, apiKey: API_KEY });
  assert.deepEqual(first.receiver, { publicKey: first.publicKey, project: PROJECT, apiKey: API_KEY });
  assert.match(first.rules, /rules_version/);
  assert.deepEqual(readReceiver(env.s), first.receiver, 'this app sends to it at once');
  const privateKey = await env.vault.use(RECEIVER_KEY_ID, SYSTEM_ID);
  assert.equal(publicKeyOf(privateKey), first.publicKey);
  assert.equal(await env.vault.use(SERVICE_ACCOUNT_ID, SYSTEM_ID), account.text);
  assert.deepEqual(new KvRepo(env.s.db).get(SETUP_KEY.ns, SETUP_KEY.key), first.receiver);
  assert.deepEqual(feedback.status(), { sending: true, receiving: true });
  const answer = JSON.stringify(first);
  const logged = JSON.stringify((env.s.log as MemoryLogger).entries);
  for (const secret of [privateKey, 'BEGIN PRIVATE KEY']) {
    assert.equal(answer.includes(secret), false, 'never in the answer');
    assert.equal(logged.includes(secret), false, 'never in the log');
  }
  const second = await feedback.setup(input);
  assert.deepEqual([second.createdKey, second.publicKey], [false, first.publicKey], 'the vault key is kept');
  const rotated = await feedback.setup({ ...input, rotate: true });
  assert.equal(rotated.createdKey, true);
  assert.notEqual(rotated.publicKey, first.publicKey);
  assert.equal(publicKeyOf(await env.vault.use(RECEIVER_KEY_ID, SYSTEM_ID)), rotated.publicKey);
});

test('setup from a packaged app writes no file and answers with the receiver to save in the source tree', async () => {
  const { env, feedback, input } = prepared();
  env.setPackaged(true);
  const result = await feedback.setup(input);
  assert.equal(result.receiverFile, undefined);
  assert.equal(readReceiver(env.s), undefined);
  assert.equal(result.receiver.project, PROJECT);
});

test('setup refuses a wrong project, key or file before it stores anything', async () => {
  const { env, feedback, input } = prepared();
  await assert.rejects(feedback.setup({ ...input, project: 'Bad Project' }), /project id/);
  await assert.rejects(feedback.setup({ ...input, apiKey: 'x' }), /web API key/);
  await assert.rejects(feedback.setup({ ...input, serviceAccountPath: 'relative.json' }), /absolute path/);
  await assert.rejects(feedback.setup({ ...input, serviceAccountPath: path.join(env.data, 'missing.json') }), /not found/);
  await assert.rejects(feedback.setup({ ...input, project: 'another-project' }), /belongs to the project "workforce-feedback-test"/);
  writeFileSync(input.serviceAccountPath, '{"type":"authorized_user"}');
  await assert.rejects(feedback.setup(input), /not a Google service account/);
  assert.deepEqual(env.vault.list(), []);
});

test('wf feedback setup | receive | status: absolute key file path, the next steps, counts; argument checks', async (t) => {
  const setupResult = { publicKey: 'P'.repeat(43), project: PROJECT, createdKey: true, receiverFile: '/src/resources/feedback/receiver.json', receiver: { publicKey: 'P'.repeat(43), project: PROJECT, apiKey: API_KEY }, rules: "rules_version = '2';" };
  const runtime = await fakeRuntime({
    'feedback.setup': () => setupResult,
    'feedback.inboxFetch': () => ({ added: 2, unreadable: 1, more: false, total: 7 }),
    'feedback.status': () => ({ sending: true, receiving: true }),
    'feedback.inboxList': () => [{ id: 'a' }, { id: 'b' }],
  });
  t.after(() => runtime.stop());
  const setup = await wf(['feedback', 'setup', '--project', PROJECT, '--api-key', API_KEY, '--service-account', 'keys/sa.json', '--rotate'], { runtime });
  assert.equal(setup.code, 0, setup.err);
  assert.deepEqual(runtime.calls.find((call) => call.method === 'feedback.setup')?.params, { project: PROJECT, apiKey: API_KEY, serviceAccountPath: path.resolve('keys/sa.json'), rotate: true });
  assert.match(setup.out, /New team key made\. Public key: P{43}/);
  assert.match(setup.out, /Wrote \/src\/resources\/feedback\/receiver\.json/);
  assert.match(setup.out, /Rules: replace the rules with these/);
  assert.match(setup.out, /rules_version = '2';/);
  assert.match(setup.out, /Build the app/);
  const receive = await wf(['feedback', 'receive'], { runtime });
  assert.equal(receive.out, 'Fetched 2 new reports; 7 reports in the inbox on this PC. 1 letter could not be opened with this PC\'s key.\n');
  const status = await wf(['feedback', 'status'], { runtime });
  assert.match(status.out, /^Sending: set up/);
  assert.match(status.out, /Receiving: this PC holds the team key – 2 reports in its inbox\./);
  assert.deepEqual(JSON.parse((await wf(['feedback', 'status', '--json'], { runtime })).out), { sending: true, receiving: true, inbox: 2 });
  for (const [args, message] of [
    [['feedback', 'setup', '--project', PROJECT, '--api-key', API_KEY], /needs --service-account/],
    [['feedback', 'receive', '--rotate'], /belongs to wf feedback setup/],
    [['feedback', 'open'], /Use wf feedback setup/],
    [['feedback'], /Usage: wf feedback/],
  ] as const) {
    const result = await wf([...args], { runtime });
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.err, message);
  }
  assert.match((await wf(['help'])).out, /\n {2}feedback setup/);
});
