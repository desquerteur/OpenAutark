// The Google world of the connected-calendar tests (B-041 track G): a fake Google (google-fake.ts) behind the
// fixture's world with a configured client ID and its secret in the vault, the whole consent as one step (open,
// the browser comes back with the code, the first sync ends), timed events in Vienna time and a tick-wait.
// Owns: fixtures only. Never imported by src/.

import assert from 'node:assert/strict';
import type { GoogleEvent } from '../../../src/runtime/calendar/sources/google-events.ts';
import { tick, world } from './fixture.ts';
import { FakeGoogle } from './google-fake.ts';
import { vienna } from './ics-fixtures.ts';

export const CLIENT = '1234-abc.apps.googleusercontent.com';

export const timed = (id: string, date: string, from: string, to: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id, summary: id, start: { dateTime: new Date(vienna(date, from)).toISOString(), timeZone: 'Europe/Vienna' }, end: { dateTime: new Date(vienna(date, to)).toISOString(), timeZone: 'Europe/Vienna' }, ...extra,
});

export async function until(check: () => boolean, rounds = 200): Promise<void> {
  for (let i = 0; i < rounds && !check(); i++) await tick();
  assert.ok(check(), 'the condition was reached');
}

export async function setup(options: { secret?: boolean } = {}) {
  const google = new FakeGoogle();
  const w = world({ fetch: google.fetch, googleClientId: CLIENT });
  if (options.secret !== false) {
    const secret = await w.vault.save({ label: 'Google client secret', kind: 'api_key', value: 'GOCSPX-secret-1', source: 'oauth2.googleapis.com' });
    w.settings.calendar.googleSecretId = secret.id;
  }
  /** The whole consent: open, the browser comes back with the code, the first sync ends. */
  const connect = async () => {
    const { authUrl } = await w.sources.connectGoogle();
    const state = new URL(authUrl).searchParams.get('state')!;
    const page = w.loopback.hit(`/?state=${encodeURIComponent(state)}&code=code-1&scope=x`);
    await until(() => !w.sources.google().waiting && w.sources.list('human').some((source) => source.kind === 'google' && source.status !== 'syncing'));
    return { authUrl, page, source: w.sources.list('human').find((source) => source.kind === 'google')! };
  };
  return { google, w, connect };
}
