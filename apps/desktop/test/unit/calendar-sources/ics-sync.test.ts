// B-041 track G: calendars by ICS link – adding one stores the address in the vault only (no agent, bound to its
// host), mirrors the window's occurrences as read-only rows and announces them; a sync changes only what changed,
// removes what vanished and keeps the rows when the link fails (status 'error' with a sentence that never repeats
// the address); hiding, showing and removing a source; the sync triggers (one start timer, resume/unlock) and that
// syncs run once per source at a time and not again within 30 s.
// Owns: checks of runtime/calendar/sources/{index,apply,repo}.ts for ICS sources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answer, tick, world } from './fixture.ts';
import { GOOGLE_EXPORT, vienna } from './ics-fixtures.ts';

const LINK = 'https://calendar.google.com/calendar/ical/robin%40example.com/private-5ecret/basic.ics';
const WEBCAL = LINK.replace('https:', 'webcal:');

function setup() {
  const w = world();
  w.feeds.set(LINK, answer(200, GOOGLE_EXPORT, { 'content-type': 'text/calendar' }));
  return w;
}

test('adding a link: the address lives only in the vault (bound to its host); rows are read-only mirrors', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: WEBCAL }, 'human');
  assert.deepEqual([source.kind, source.label, source.status, source.visible, source.writable], ['ics', 'Robin', 'ok', true, false]);
  assert.equal(source.lastSyncAt, w.clock.now());
  assert.equal(w.calls[0].url, LINK, 'webcal is read as https');
  assert.equal(w.dump().includes('private-5ecret'), false, 'the address is stored nowhere in plain text');
  const [secret] = w.secretRows();
  assert.deepEqual([secret.kind, JSON.parse(secret.domains), secret.source], ['token', [], 'calendar.google.com'], 'owner 29.10.2026: the host is where it came from, not a binding');
  assert.equal(w.sourceRows()[0].secret_id, secret.id);
  assert.equal(await w.vault.use(secret.id, 'system'), LINK);
  const rows = w.eventRows(source.id);
  assert.ok(rows.length > 10);
  assert.ok(rows.every((row) => row.read_only === 1 && row.set_by === 'sync' && row.kind === 'event' && row.owner_id === 'human' && row.created_by === 'system'));
  assert.equal(w.of('calendar.upserted').length, rows.length, 'every row is announced');
  assert.ok(w.of('calendar.sources').length >= 1);
  // the window is −7 … +60 days: the September review is too early, the November one is in
  const reviews = rows.filter((row) => String(row.external_id).startsWith('review@')).map((row) => row.start_at);
  assert.deepEqual(reviews, [vienna('2026-10-30', '15:00'), vienna('2026-11-27', '15:00')]);
  // the calendar sees them: a mirrored event is busy time for the planner
  assert.ok(w.calendar.busy('human', vienna('2026-10-24', '18:00'), vienna('2026-10-24', '20:00')).length === 1);
});

test('a link that does not return a calendar is refused and nothing is stored', async () => {
  const w = world();
  w.feeds.set('https://example.com/login', answer(200, '<html>Sign in</html>'));
  await assert.rejects(w.sources.addIcs({ url: 'https://example.com/login' }, 'human'), /did not return a calendar/);
  await assert.rejects(w.sources.addIcs({ url: 'https://example.com/missing.ics' }, 'human'), (error: Error) => /HTTP 404/.test(error.message) && !error.message.includes('example.com'));
  await assert.rejects(w.sources.addIcs({ url: 'ftp://example.com/a.ics' }, 'human'), /not a calendar link/);
  w.feeds.set('https://example.com/huge.ics', answer(200, 'BEGIN:VCALENDAR', { 'content-length': String(6_000_000) }));
  await assert.rejects(w.sources.addIcs({ url: 'https://example.com/huge.ics' }, 'human'), /larger than 5 MB/);
  assert.deepEqual([w.sourceRows().length, w.secretRows().length], [0, 0]);
});

test('a sync changes only what changed (same row, next rev), removes vanished occurrences and adds new ones', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: LINK, label: 'Family' }, 'human');
  assert.equal(source.label, 'Family');
  const before = new Map(w.eventRows(source.id).map((row) => [row.external_id, row]));
  const changed = GOOGLE_EXPORT
    .replace('SUMMARY:Abendessen\\, Oma', 'SUMMARY:Abendessen bei Oma')
    .replace('DTSTART;VALUE=DATE:20261026\r\nDTEND;VALUE=DATE:20261027\r\nUID:nationalfeiertag@google.com\r\nSUMMARY:Nationalfeiertag\r\nTRANSP:TRANSPARENT\r\n', 'DTSTART:20261031T090000Z\r\nUID:new@google.com\r\nSUMMARY:Flohmarkt\r\n');
  w.feeds.set(LINK, answer(200, changed));
  w.events.length = 0;
  w.clock.advance(60_000);
  const [after] = await w.sources.sync(source.id, 'button');
  assert.equal(after.status, 'ok');
  const rows = new Map(w.eventRows(source.id).map((row) => [row.external_id, row]));
  const dinner = rows.get('dinner@google.com')!;
  assert.deepEqual([dinner.id, dinner.title, dinner.rev], [before.get('dinner@google.com')!.id, 'Abendessen bei Oma', 1]);
  assert.equal(rows.has('nationalfeiertag@google.com'), false);
  assert.ok(rows.has('new@google.com'));
  assert.deepEqual(w.of('calendar.upserted').map((event) => event.externalId).sort(), ['dinner@google.com', 'new@google.com']);
  assert.deepEqual(w.of('calendar.removed').map((event) => event.id), [before.get('nationalfeiertag@google.com')!.id]);
  assert.equal(rows.get('standup@google.com#20261019T070000Z')!.rev, 0, 'unchanged rows are not written');
});

test('a failing link keeps the rows and shows a sentence without the address; the next good sync clears it', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: LINK }, 'human');
  const count = w.eventRows(source.id).length;
  w.feeds.set(LINK, answer(403, 'forbidden'));
  w.clock.advance(60_000);
  const [failed] = await w.sources.sync(undefined, 'resume');
  assert.equal(failed.status, 'error');
  assert.match(failed.error!, /refused \(HTTP 403\)/);
  assert.equal(failed.error!.includes('google.com'), false);
  assert.equal(failed.lastSyncAt, source.lastSyncAt, 'the last good sync stays');
  assert.equal(w.eventRows(source.id).length, count);
  w.feeds.set(LINK, answer(200, GOOGLE_EXPORT));
  const [again] = await w.sources.sync(source.id);
  assert.deepEqual([again.status, again.error, again.lastSyncAt], ['ok', undefined, w.clock.now()]);
});

test('hiding a source takes its rows out of the views (announced as removed), showing brings them back; a hidden sync is quiet', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: LINK }, 'human');
  const ids = w.eventRows(source.id).map((row) => row.id);
  w.events.length = 0;
  const hidden = w.sources.update(source.id, { visible: false }, 'human');
  assert.equal(hidden.visible, false);
  assert.deepEqual(w.of('calendar.removed').map((event) => event.id).sort(), [...ids].sort());
  assert.deepEqual(w.calendar.list('human', vienna('2026-10-19'), vienna('2026-11-03')).events.filter((event) => event.sourceId === source.id), []);
  w.feeds.set(LINK, answer(200, GOOGLE_EXPORT.replace('SUMMARY:Pills', 'SUMMARY:Vitamins')));
  w.clock.advance(60_000);
  w.events.length = 0;
  await w.sources.sync(source.id);
  assert.equal(w.of('calendar.upserted').length, 0, 'rows of a hidden source change without a word');
  w.sources.update(source.id, { visible: true, label: 'Home' }, 'human');
  assert.equal(w.of('calendar.upserted').length, ids.length);
  assert.equal(w.sources.list('human')[0].label, 'Home');
});

test('removing a source removes its rows, its vault entry and announces both', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: LINK }, 'human');
  const count = w.eventRows(source.id).length;
  w.events.length = 0;
  await w.sources.remove(source.id, 'human');
  assert.deepEqual([w.sourceRows().length, w.secretRows().length, w.eventRows(source.id).length], [0, 0, 0]);
  assert.equal(w.of('calendar.removed').length, count);
  assert.equal(w.of('calendar.sources').length, 1);
  await assert.rejects(w.sources.sync(source.id), /not found/i);
  assert.throws(() => w.sources.update(source.id, { visible: false }, 'human'), /not found/i);
});

test('triggers: one timer after start, resume and unlock; a sync runs once per source at a time and not again within 30 s', async () => {
  const w = setup();
  const source = await w.sources.addIcs({ url: LINK }, 'human');
  const fetches = () => w.calls.filter((call) => call.url === LINK).length;
  assert.equal(fetches(), 1);
  assert.equal(w.timers.only()!.ms, 4_000, 'the start sync waits a moment (one timer)');
  w.clock.advance(10_000);
  w.timers.fire();
  await tick();
  assert.equal(fetches(), 1, 'synced 10 s ago: not read again');
  w.clock.advance(60_000);
  const first = w.sources.sync(undefined, 'resume');
  const second = w.sources.sync(source.id, 'button');
  assert.equal(w.sources.list('human')[0].status, 'syncing');
  await Promise.all([first, second]);
  assert.equal(fetches(), 2, 'two callers, one read');
  assert.equal(w.sources.list('human')[0].status, 'ok');
  w.clock.advance(60_000);
  for (const listener of w.powerListeners) listener('suspend');
  await tick();
  assert.equal(fetches(), 2, 'suspend is no trigger');
  for (const listener of w.powerListeners) listener('unlock');
  await tick(); await tick();
  assert.equal(fetches(), 3);
  w.sources.stop();
  assert.equal(w.timers.pending.length, 0);
});

test('B-078: a room\'s calendar is listed for the owner with its room, so it can be removed (with its secret)', async () => {
  const w = setup();
  const mine = await w.sources.addIcs({ url: LINK }, 'human');
  const room = await w.sources.addIcs({ url: LINK, label: 'Meeting room 2', room: 'room:meeting-room-2' }, 'human');
  assert.deepEqual(w.sources.list('human').map((source) => source.id), [mine.id], 'my own list stays mine');
  assert.deepEqual(w.sources.listWithRooms('human').map((source) => [source.id, source.ownerId]), [[mine.id, 'human'], [room.id, 'room:meeting-room-2']]);
  await w.sources.remove(room.id, 'human');
  assert.deepEqual(w.sources.listWithRooms('human').map((source) => source.id), [mine.id]);
  assert.equal(w.secretRows().length, 1, 'the room link left the vault');
});
