// AF-003 "Feedback does not work and nothing is in the log": a Bug and an Idea reach the (fake) mailbox and come back
// as sent with a receipt; every failure – no connection, no answer in time, a server error, a refusal, sending not set
// up – is a clear user-safe error with its reason, leaves the report saved on the PC, and writes a log line; the start
// logs whether this build can send at all. Log lines carry ids, kinds and reasons – never the report's text.
// Owns: these assertions. Never: contacts Firebase or Google.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { FeedbackService, sendFailure } from '../../../src/runtime/feedback/service.ts';
import { generateReceiverKeys, openReport } from '../../../src/runtime/feedback/seal.ts';
import { reportNumber } from '../../../src/shared/model/feedback-delivery.ts';
import { WorkforceError } from '../../../src/shared/errors.ts';
import type { MemoryLogger } from '../../../src/runtime/system/log.ts';
import { API_KEY, PROJECT, fakeMailbox, feedbackEnv, type Env } from './fakes.ts';

const envs: Env[] = [];
after(() => { for (const env of envs) env.cleanup(); });

function setup(options: { receiver?: null } = {}) {
  const env = feedbackEnv();
  envs.push(env);
  const team = generateReceiverKeys();
  const receiver = options.receiver === null ? null : { publicKey: team.publicKey, project: PROJECT, apiKey: API_KEY };
  const box = fakeMailbox();
  const service = (run: typeof fetch = box.fetch) => new FeedbackService({ services: () => env.s, receiver, fetch: run, os: 'win32 10.0.26300 x64' });
  const log = env.s.log as MemoryLogger;
  const lines = (message: string) => log.entries.filter((entry) => entry.message === message);
  return { env, team, box, service, log, lines };
}

test('AF-003: a Bug and an Idea from the person reach the mailbox, come back as sent with a receipt, and are logged', async () => {
  const { team, box, service, log, lines } = setup();
  const feedback = service();
  const bug = feedback.create({ kind: 'bug', text: 'The send button does nothing', author: 'human' });
  const idea = feedback.create({ kind: 'idea', text: 'A dark sidebar would be nice', author: 'human' });
  const sentBug = await feedback.send(bug.id);
  const sentIdea = await feedback.send(idea.id);
  for (const sent of [sentBug, sentIdea]) {
    assert.equal(sent.status, 'sent');
    assert.match(sent.receiptId ?? '', /^[0-9a-f-]{36}$/, 'a receipt id (the mailbox document id)');
  }
  assert.deepEqual(feedback.list().map((report) => [report.kind, report.status]).sort(), [['bug', 'sent'], ['idea', 'sent']], 'both read as sent afterwards');
  const opened = [...box.docs.entries()].map(([id, sealed]) => ({ id, ...JSON.parse(openReport(team.privateKey, sealed).toString('utf8')) }));
  assert.deepEqual(opened.map((letter) => [letter.kind, letter.text]).sort(), [['bug', 'The send button does nothing'], ['idea', 'A dark sidebar would be nice']]);
  assert.deepEqual(opened.map((letter) => letter.id).sort(), [sentBug.receiptId, sentIdea.receiptId].sort(), 'the number the sender sees is the team\'s document id');

  assert.deepEqual(lines('feedback saved').map((entry) => [entry.level, entry.data?.id, entry.data?.kind, entry.data?.by]), [['info', bug.id, 'bug', 'human'], ['info', idea.id, 'idea', 'human']]);
  assert.deepEqual(lines('feedback sent').map((entry) => [entry.level, entry.data?.id, entry.data?.receipt]), [['info', bug.id, sentBug.receiptId], ['info', idea.id, sentIdea.receiptId]]);
  assert.equal(lines('feedback stays on this PC: sending is not set up in this build').length, 0);
  assert.equal(lines('feedback send failed').length, 0);
  const logged = JSON.stringify(log.entries);
  assert.equal(logged.includes('send button does nothing') || logged.includes('dark sidebar'), false, 'the log never holds the report text');
});

test('AF-003: no connection is a clear error, keeps the report on the PC, is logged with its reason, and Send again delivers it', async () => {
  const { box, service, lines } = setup();
  const feedback = service();
  const report = feedback.create({ kind: 'bug', text: 'Offline report', author: 'human' });
  box.state.create = 'throw'; // fetch failed: no network, DNS, a closed port
  await assert.rejects(feedback.send(report.id), (error: unknown) => {
    assert.ok(error instanceof WorkforceError);
    assert.equal(error.code, 'unavailable');
    assert.equal(error.details?.reason, 'offline');
    assert.match(error.message, /could not be sent right now: the feedback server is not reachable\. Check the internet connection\. Your report is saved on this PC/);
    assert.doesNotMatch(error.message, /fetch failed|TypeError/, 'no raw transport text');
    return true;
  });
  assert.equal(feedback.list().find((entry) => entry.id === report.id)?.status, 'local', 'still saved, not sent');
  const [failed] = lines('feedback send failed');
  assert.equal(failed.level, 'warn');
  assert.deepEqual({ ...failed.data, error: undefined }, { id: report.id, code: 'unavailable', reason: 'offline', error: undefined });
  assert.match(String(failed.data?.error), /not reachable/);

  box.state.create = null; // back online: the same saved report goes out
  const sent = await feedback.send(report.id);
  assert.equal(sent.status, 'sent');
  assert.equal(box.docs.size, 1);
  assert.equal(lines('feedback sent').length, 1);
});

test('AF-003: no answer in time, a server error and a refusal each say why (and the log keeps the HTTP status)', async () => {
  const timeout = setup();
  const slow = timeout.service((async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); }) as typeof fetch);
  const late = slow.create({ kind: 'idea', text: 'Slow server', author: 'human' });
  await assert.rejects(slow.send(late.id), (error: WorkforceError) => error.details?.reason === 'timeout' && /did not answer in time/.test(error.message));
  assert.equal(timeout.lines('feedback send failed')[0]?.data?.reason, 'timeout');

  const server = setup();
  server.box.state.create = 503;
  const broken = server.service();
  const one = broken.create({ kind: 'bug', text: 'Server error', author: 'human' });
  await assert.rejects(broken.send(one.id), (error: WorkforceError) => error.details?.reason === 'server' && error.details?.status === 503 && /could not be sent right now/.test(error.message));
  assert.deepEqual([server.lines('feedback send failed')[0]?.data?.reason, server.lines('feedback send failed')[0]?.data?.status], ['server', 503]);

  const refused = setup();
  const wrongKey = refused.service(((input: string | URL | Request, init?: RequestInit) => refused.box.fetch(String(input).replace(`key=${API_KEY}`, 'key=AIzaWrongWrongWrongWrong00000'), init)) as typeof fetch);
  const two = wrongKey.create({ kind: 'bug', text: 'Refused', author: 'human' });
  await assert.rejects(wrongKey.send(two.id), (error: WorkforceError) => error.details?.reason === 'refused' && error.details?.status === 403 && /refused this report/.test(error.message));
  assert.equal(refused.lines('feedback send failed')[0]?.data?.reason, 'refused');
});

test('AF-003: where sending is not set up, saving says so in the log and Send fails with reason not_set_up', async () => {
  const { service, lines, box } = setup({ receiver: null });
  const feedback = service();
  assert.deepEqual(feedback.status(), { sending: false, receiving: false });
  const report = feedback.create({ kind: 'bug', text: 'Not set up', author: 'human' });
  assert.equal(report.status, 'local');
  const [stays] = lines('feedback stays on this PC: sending is not set up in this build');
  assert.equal(stays?.level, 'warn');
  assert.equal(stays?.data?.id, report.id);
  await assert.rejects(feedback.send(report.id), (error: WorkforceError) => error.details?.reason === 'not_set_up' && /not set up in this version/.test(error.message));
  assert.deepEqual(lines('feedback send failed').map((entry) => entry.data?.reason), ['not_set_up']);
  assert.equal(box.calls.length, 0, 'nothing went out');
});

test('AF-003: the start logs once whether this build can send', () => {
  const ready = setup();
  ready.service().start();
  assert.equal(ready.lines('feedback sending is set up')[0]?.data?.project, PROJECT);
  const none = setup({ receiver: null });
  none.service().start();
  assert.equal(none.lines('feedback sending is not set up: reports stay on this PC (no valid receiver.json)')[0]?.level, 'warn');
});

test('AF-003: the report number is the first eight letters and digits of the receipt, upper case; failures map to log fields', () => {
  assert.equal(reportNumber('668fc8de-df52-405c-8743-d264e47cfadd'), '668FC8DE');
  assert.equal(reportNumber('ab-cd'), 'ABCD');
  assert.deepEqual(sendFailure('fb_1', new WorkforceError('unavailable', 'x', { details: { reason: 'server', status: 500 } })), { id: 'fb_1', code: 'unavailable', reason: 'server', status: 500, error: 'x' });
  assert.deepEqual(sendFailure('fb_2', new Error('boom')), { id: 'fb_2', code: 'internal', error: 'boom' });
});
