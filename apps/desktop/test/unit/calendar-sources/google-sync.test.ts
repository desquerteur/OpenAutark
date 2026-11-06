// B-041 track G: Google Calendar against a fake Google – without a client ID nothing pretends to work; the consent
// (PKCE S256 on a 127.0.0.1 loopback, opened in the system browser) ends in a source whose refresh token lives in the
// vault only (no agent, bound to oauth2.googleapis.com) and whose access token is never stored; the first read pages
// through the main calendar and keeps the sync token; later reads are incremental (moved, cancelled, new, a deleted
// series with its instances); 410 reads everything again; invalid_grant shows 'reconnect' until the person connects
// again (same source); removing it revokes the sign-in.
// Owns: checks of runtime/calendar/sources/{google,google-auth,google-api,google-events}.ts and index.ts for Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PC, world } from './fixture.ts';
import { CLIENT, setup, timed, until } from './google-world.ts';
import { vienna } from './ics-fixtures.ts';

test('without a client ID Google is not configured and connecting is refused; the environment can provide one', async () => {
  const w = world();
  assert.deepEqual(w.sources.google(), { configured: false, connected: false });
  await assert.rejects(w.sources.connectGoogle(), /needs a client ID/);
  assert.equal(w.loopback.isOpen(), false);
  const fromEnv = world({ env: { WORKFORCE_GOOGLE_CLIENT_ID: CLIENT } });
  assert.equal(fromEnv.sources.google().configured, true);
});

test('connect: PKCE S256 consent on the loopback, opened in the browser; the tokens never reach the database', async () => {
  const { google, w, connect } = await setup();
  google.put(timed('meet-1', '2026-10-26', '10:00', '11:00'));
  google.put({ id: 'holiday', summary: 'Nationalfeiertag', start: { date: '2026-10-26' }, end: { date: '2026-10-27' } });
  google.put(timed('declined', '2026-10-27', '10:00', '11:00', { attendees: [{ self: true, responseStatus: 'declined' }] }));
  google.put(timed('meet-2', '2026-10-28', '14:00', '15:30', { description: '<b>Agenda</b><br>1. Budget', location: 'Room 4' }));
  const { authUrl, page, source } = await connect();
  const url = new URL(authUrl);
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual([params.client_id, params.redirect_uri, params.response_type, params.code_challenge_method, params.access_type, params.prompt],
    [CLIENT, 'http://127.0.0.1:50123', 'code', 'S256', 'offline', 'consent']);
  assert.deepEqual(params.scope.split(' ').sort(), ['https://www.googleapis.com/auth/calendar.app.created', 'https://www.googleapis.com/auth/calendar.events.readonly']);
  assert.deepEqual(w.opened, [authUrl], 'opened in the system browser');
  assert.equal(page.status, 200);
  assert.match(page.body, /connected/);
  assert.equal(w.loopback.isOpen(), false, 'the listener closed after the one answer');
  const exchange = google.tokenForms[0];
  assert.deepEqual([exchange.get('grant_type'), exchange.get('code'), exchange.get('client_secret'), exchange.get('redirect_uri')], ['authorization_code', 'code-1', 'GOCSPX-secret-1', 'http://127.0.0.1:50123']);
  assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), params.code_challenge, 'the verifier matches the challenge');
  assert.deepEqual([source.label, source.pcDeviceId, source.writable, source.status], ['robin@example.com', PC, true, 'ok']);
  const dump = w.dump();
  for (const secret of ['rt-1', 'at-1', 'GOCSPX-secret-1', 'code-1', exchange.get('code_verifier')!]) assert.equal(dump.includes(secret), false, `${secret} is not stored in plain text`);
  const vaulted = w.secretRows().find((row) => row.label === 'Google Calendar sign-in')!;
  assert.deepEqual([vaulted.kind, JSON.parse(vaulted.domains), vaulted.source], ['token', [], 'oauth2.googleapis.com'], 'owner 29.10.2026: the host is where it came from, not a binding');
  assert.equal(w.sourceRows()[0].secret_id, vaulted.id);
  assert.deepEqual(w.sources.google(), { configured: true, connected: true, sourceId: source.id });
  // the first read: two pages of the main calendar, then the sync token
  const reads = google.calls.filter((call) => call.url.includes('/calendars/primary/events'));
  assert.equal(reads.length, 2);
  assert.ok(reads.every((call) => !call.url.includes('syncToken')) && reads[0].url.includes('singleEvents=true') && reads[0].url.includes('timeMin='));
  assert.equal(w.sourceRows()[0].sync_token, 'st-4');
  const rows = new Map(w.eventRows(source.id).map((row) => [row.external_id, row]));
  assert.deepEqual([...rows.keys()].sort(), ['holiday', 'meet-1', 'meet-2'], 'declined events are no busy time');
  assert.deepEqual([rows.get('holiday')!.all_day, rows.get('holiday')!.start_at, rows.get('holiday')!.end_at], [1, vienna('2026-10-26'), vienna('2026-10-27')]);
  assert.deepEqual([rows.get('meet-2')!.notes, rows.get('meet-2')!.tz, rows.get('meet-2')!.read_only], ['Room 4\n\nAgenda\n1. Budget', 'Europe/Vienna', 1]);
});

test('incremental reads apply changes since the token; a deleted series takes its instances along; 410 reads everything again', async () => {
  const { google, w, connect } = await setup();
  google.put(timed('meet-1', '2026-10-26', '10:00', '11:00'));
  google.put(timed('weekly_20261026T080000Z', '2026-10-26', '09:00', '09:30', { recurringEventId: 'weekly' }));
  google.put(timed('weekly_20261102T080000Z', '2026-11-02', '09:00', '09:30', { recurringEventId: 'weekly' }));
  const { source } = await connect();
  assert.equal(w.eventRows(source.id).length, 3);
  google.put(timed('meet-1', '2026-10-26', '12:00', '13:00'));
  google.put(timed('meet-3', '2026-10-29', '08:00', '09:00'));
  google.cancel('weekly');
  google.put(timed('far', '2027-06-01', '08:00', '09:00'));
  w.clock.advance(60_000);
  w.events.length = 0;
  const [after] = await w.sources.sync(source.id);
  assert.equal(after.status, 'ok');
  const incremental = google.calls.filter((call) => call.url.includes('/calendars/primary/events')).at(-1)!;
  assert.match(incremental.url, /syncToken=st-3/);
  assert.equal(incremental.url.includes('timeMin'), false, 'no filters next to a sync token');
  const rows = new Map(w.eventRows(source.id).map((row) => [row.external_id, row]));
  assert.deepEqual([...rows.keys()].sort(), ['meet-1', 'meet-3'], 'the series and its instances went; events past the window are not kept');
  assert.deepEqual([rows.get('meet-1')!.start_at, rows.get('meet-1')!.rev], [vienna('2026-10-26', '12:00'), 1]);
  assert.equal(w.of('calendar.removed').length, 2);
  assert.equal(w.sourceRows()[0].sync_token, 'st-7');
  google.expireTokens = true;
  google.put(timed('meet-4', '2026-10-30', '08:00', '09:00'));
  w.clock.advance(60_000);
  await w.sources.sync(source.id);
  const reads = google.calls.filter((call) => call.url.includes('/calendars/primary/events')).map((call) => call.url);
  const refused = reads.findLastIndex((url) => url.includes('syncToken='));
  assert.ok(refused > 0 && reads.length > refused + 1);
  assert.ok(reads.slice(refused + 1).every((url) => !url.includes('syncToken') && url.includes('timeMin=')), '410: a full read follows');
  assert.deepEqual(w.eventRows(source.id).map((row) => row.external_id).sort(), ['meet-1', 'meet-3', 'meet-4']);
  assert.equal(w.sources.list('human')[0].status, 'ok');
});

test('an expired sign-in (invalid_grant) shows "reconnect"; connecting again renews the same source', async () => {
  const { google, w, connect } = await setup();
  const { source } = await connect();
  google.refreshError = 'invalid_grant';
  w.clock.advance(2 * 3_600_000); // the access token expired
  const [expired] = await w.sources.sync(source.id);
  assert.deepEqual([expired.status, expired.error], ['reconnect', 'Google sign-in expired. Connect again.']);
  assert.equal(w.sources.google().connected, true, 'still connected – it needs a new consent');
  google.refreshError = undefined;
  const again = await connect();
  assert.equal(again.source.id, source.id);
  assert.equal(again.source.status, 'ok');
  assert.equal(w.sourceRows().length, 1);
  assert.equal(w.secretRows().filter((row) => row.label === 'Google Calendar sign-in').length, 1, 'the renewed token replaced the old one');
});

test('consent failures are reported without creating a source; a wrong client secret says so', async () => {
  const { google, w } = await setup();
  const first = await w.sources.connectGoogle();
  assert.equal(w.sources.google().waiting, true);
  const state = new URL(first.authUrl).searchParams.get('state')!;
  w.loopback.hit(`/?state=${state}&error=access_denied`);
  await until(() => !w.sources.google().waiting);
  assert.deepEqual(w.sources.google(), { configured: true, connected: false, error: 'Google sign-in was cancelled.' });
  google.tokenForms.length = 0;
  const second = await w.sources.connectGoogle();
  assert.equal(w.sources.google().error, undefined, 'a new consent clears the last failure');
  w.loopback.hit(`/?state=${new URL(second.authUrl).searchParams.get('state')}&code=wrong-code`);
  await until(() => !w.sources.google().waiting);
  assert.equal(w.sources.google().connected, false);
  assert.equal(w.sourceRows().length, 0);
  assert.equal(google.tokenForms.length, 1);
});

test('removing the Google source removes its rows and vault entry and asks Google to revoke the sign-in', async () => {
  const { google, w, connect } = await setup();
  google.put(timed('meet-1', '2026-10-26', '10:00', '11:00'));
  const { source } = await connect();
  await w.sources.remove(source.id, 'human');
  await until(() => google.revoked.length === 1);
  assert.deepEqual(google.revoked, ['rt-1']);
  assert.deepEqual([w.sourceRows().length, w.eventRows(source.id).length, w.secretRows().filter((row) => row.label === 'Google Calendar sign-in').length], [0, 0, 0]);
  assert.deepEqual(w.sources.google(), { configured: true, connected: false });
});
