// AF-019: the update source (src/main/updates/source.ts, source-store.ts) and how UpdateService uses it – the
// repository choice (fork by default, teydra/OpenAutark or another owner/name) reaches the updater's feed, the channel
// its prerelease flag, automatic checks can be off, "nothing published yet" is a calm 'current' with a message,
// an offered version must be newer (semver with prereleases) and the release notes arrive as plain text.
// Owns: these assertions. Never: electron, network or real timers (a temp folder for the stored file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UpdateService } from '../../../src/main/updates/update-service.ts';
import { compareVersions, DEFAULT_SOURCE, feedOptions, isNoReleaseError, KNOWN_REPOSITORIES, MAX_NOTES, noReleaseText, normalizeSource, offersUpdate, parseRepository, releaseNotesText } from '../../../src/main/updates/source.ts';
import { loadUpdateSource, saveUpdateSource, sourceFile } from '../../../src/main/updates/source-store.ts';
import { RELEASE_REPOSITORY, UPSTREAM_REPOSITORY } from '../../../src/main/updates/release.ts';
import { manualDownloadURL } from '../../../src/main/updates/manual-download.ts';
import { updateSourcePatch } from '../../../src/main/ipc-args.ts';
import { FORK_REPOSITORY, UPSTREAM_REPOSITORY as UI_UPSTREAM, canCheckNow, showsNotice, sourceChoice, updateStatusText } from '../../../src/ui/settings/updates-text.ts';
import type { UpdateState } from '../../../src/shared/model/system.ts';
import { fakeClock, fakeUpdater, settle } from './update-fakes.ts';

test('the source: the fork by default, teydra/OpenAutark selectable, the settings page names the same two', () => {
  assert.deepEqual(DEFAULT_SOURCE, { repository: 'desquerteur/OpenAutark', channel: 'stable', autoCheck: true });
  assert.deepEqual(KNOWN_REPOSITORIES, ['desquerteur/OpenAutark', 'teydra/OpenAutark']);
  assert.equal(FORK_REPOSITORY, RELEASE_REPOSITORY);
  assert.equal(UI_UPSTREAM, UPSTREAM_REPOSITORY);
  assert.deepEqual(feedOptions(DEFAULT_SOURCE), { provider: 'github', owner: 'desquerteur', repo: 'OpenAutark' });
  assert.deepEqual(feedOptions({ repository: 'teydra/OpenAutark' }), { provider: 'github', owner: 'teydra', repo: 'OpenAutark' });
});

test('parseRepository accepts owner/name (also as a github.com link) and nothing else', () => {
  assert.deepEqual(parseRepository('desquerteur/OpenAutark'), { owner: 'desquerteur', repo: 'OpenAutark' });
  assert.deepEqual(parseRepository('  https://github.com/teydra/OpenAutark/ '), { owner: 'teydra', repo: 'OpenAutark' });
  assert.deepEqual(parseRepository('a-b/c.d_e-f.git'), { owner: 'a-b', repo: 'c.d_e-f' });
  for (const bad of ['', 'OpenAutark', 'a/b/c', '-a/b', 'a-/b', 'a/..', 'a b/c', 'a/b?x=1', 'https://evil.example/a/b', 42, null, `${'x'.repeat(40)}/y`]) {
    assert.equal(parseRepository(bad), null, String(bad));
  }
});

test('normalizeSource keeps valid fields and falls back field by field', () => {
  assert.deepEqual(normalizeSource({ repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false }), { repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false });
  assert.deepEqual(normalizeSource({ repository: 'nope', channel: 'nightly', autoCheck: 'yes' }), DEFAULT_SOURCE);
  assert.deepEqual(normalizeSource(null), DEFAULT_SOURCE);
  assert.deepEqual(normalizeSource({ channel: 'prerelease' }, { repository: 'x/y', channel: 'stable', autoCheck: false }), { repository: 'x/y', channel: 'prerelease', autoCheck: false });
});

test('compareVersions orders by semver, prereleases before their release', () => {
  const ordered = ['0.3.3', '0.3.4', '0.3.5-alpha', '0.3.5-alpha.1', '0.3.5-alpha.beta', '0.3.5-beta', '0.3.5-beta.2', '0.3.5-beta.11', '0.3.5-rc.1', '0.3.5', '0.3.10', '0.4.0', '1.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(compareVersions(ordered[i]!, ordered[j]!), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  assert.equal(compareVersions('v0.3.5', '0.3.5'), 0, 'a tag prefix v is fine');
  assert.equal(compareVersions('0.3.5+build.7', '0.3.5'), 0, 'build metadata does not count');
  assert.equal(compareVersions('garbage', '0.3.5'), 0, 'unparsable compares as equal (never offered)');
});

test('offersUpdate: only newer versions, prereleases only on the prerelease channel', () => {
  assert.equal(offersUpdate('0.3.5', '0.3.4', 'stable'), true);
  assert.equal(offersUpdate('0.3.4', '0.3.4', 'stable'), false);
  assert.equal(offersUpdate('0.3.3', '0.3.4', 'stable'), false, 'switching to an older source never downgrades');
  assert.equal(offersUpdate('0.3.5-beta.1', '0.3.4', 'stable'), false);
  assert.equal(offersUpdate('0.3.5-beta.1', '0.3.4', 'prerelease'), true);
  assert.equal(offersUpdate('0.3.5', '0.3.5-beta.1', 'stable'), true, 'from a prerelease to its release');
  assert.equal(offersUpdate('nonsense', '0.3.4', 'prerelease'), false);
});

test('release notes become plain text (HTML or a list per version), bounded', () => {
  assert.equal(releaseNotesText('<h2>What&#39;s new</h2><ul><li>Updates from <b>your fork</b></li><li>A &amp; B</li></ul><script>alert(1)</script>'), "What's new\n• Updates from your fork\n• A & B");
  assert.equal(releaseNotesText([{ version: '0.3.6', note: '<p>Two</p>' }, { version: '0.3.5', note: 'One' }, { version: '0.3.4', note: null }]), '0.3.6\nTwo\n\n0.3.5\nOne');
  assert.equal(releaseNotesText(''), undefined);
  assert.equal(releaseNotesText(null), undefined);
  const long = releaseNotesText('x'.repeat(MAX_NOTES * 2))!;
  assert.equal(long.length, MAX_NOTES);
  assert.ok(long.endsWith('…'));
});

test('the GitHub provider\'s "nothing published" codes are recognised, other failures are not', () => {
  for (const code of ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'HTTP_ERROR_404']) assert.equal(isNoReleaseError({ code }), true, code);
  for (const value of [{ code: 'ERR_UPDATER_INVALID_RELEASE_FEED' }, { code: 'HTTP_ERROR_500' }, new Error('offline'), undefined, null]) assert.equal(isNoReleaseError(value), false);
});

function service(source?: Parameters<typeof normalizeSource>[0], script?: Parameters<typeof fakeUpdater>[0]) {
  const clock = fakeClock();
  const fake = fakeUpdater(script);
  const feeds: unknown[] = [];
  fake.updater.setFeedURL = (options) => { feeds.push(options); };
  const states: UpdateState[] = [];
  const s = new UpdateService(fake.updater, {
    packaged: true, enabled: true, platform: 'win32', arch: 'x64', version: '0.3.4',
    autoDownload: () => false,
    facts: async () => ({ rendererReady: true, idleSeconds: 600, runtimeReady: true }),
    prepareInstall: async () => {}, openExternal: async () => {},
    changed: (state) => { states.push(state); },
    source: source === undefined ? undefined : normalizeSource(source),
    ...clock.hooks,
  });
  return { s, clock, feeds, states, ...fake };
}

const noRelease = () => Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' });

test('the service points the updater at the fork by default and reports the source in its state', () => {
  const h = service();
  assert.deepEqual(h.feeds, [{ provider: 'github', owner: 'desquerteur', repo: 'OpenAutark' }]);
  assert.equal(h.updater.allowPrerelease, false);
  assert.equal(h.s.state.source, 'desquerteur/OpenAutark');
  assert.equal(h.s.state.channel, 'stable');
  assert.equal(h.s.state.autoCheck, true);
  assert.equal(h.s.state.downloadURL, 'https://github.com/desquerteur/OpenAutark/releases/latest/download/autark-windows-x64.exe');
});

test('no release in the source yet: a clear "current" message, no error, and the retries stay quiet', async () => {
  const h = service();
  h.updater.checkForUpdates = async () => { h.emit('checking-for-update'); const error = noRelease(); h.emit('error', error); throw error; };
  const state = await h.s.check();
  assert.equal(state.status, 'current');
  assert.equal(state.message, noReleaseText('desquerteur/OpenAutark'));
  assert.match(state.message!, /No update has been published in desquerteur\/OpenAutark yet/);
  assert.equal(state.failure, undefined);
  assert.ok(!h.states.some((entry) => entry.status === 'error'));
  assert.equal(updateStatusText(state), state.message, 'the settings page shows that message');
});

test('a 404 (repository not found or private) is the same calm message; other failures stay errors', async () => {
  const h = service({ repository: 'someone/missing' });
  h.updater.checkForUpdates = async () => { const error = Object.assign(new Error('404'), { code: 'HTTP_ERROR_404' }); h.emit('error', error); throw error; };
  assert.equal((await h.s.check()).status, 'current');
  h.updater.checkForUpdates = async () => { const error = Object.assign(new Error('boom'), { code: 'HTTP_ERROR_500' }); h.emit('error', error); throw error; };
  await h.clock.advance(60_000);
  assert.equal((await h.s.check()).status, 'error');
});

test('switching the source to teydra/OpenAutark repoints the feed, forgets an offer and checks there at once', async () => {
  const h = service(undefined, { version: '0.3.5' });
  await h.s.check();
  assert.equal(h.s.state.status, 'available');
  const checks = h.calls.check;
  const state = h.s.setSource({ repository: 'teydra/OpenAutark' });
  assert.equal(state.source, 'teydra/OpenAutark');
  assert.equal(state.downloadURL, 'https://github.com/teydra/OpenAutark/releases/latest/download/autark-windows-x64.exe');
  assert.deepEqual(h.feeds.at(-1), { provider: 'github', owner: 'teydra', repo: 'OpenAutark' });
  await settle();
  assert.equal(h.calls.check, checks + 1, 'checked the new source');
  assert.equal(manualDownloadURL({ source: 'teydra/OpenAutark' }), 'https://github.com/teydra/OpenAutark/releases/latest');
});

test('the prerelease channel sets the updater flag; an invalid repository keeps the old one', () => {
  const h = service();
  h.s.setSource({ channel: 'prerelease' });
  assert.equal(h.updater.allowPrerelease, true);
  h.s.setSource({ repository: 'not a repo' });
  assert.equal(h.s.state.source, 'desquerteur/OpenAutark');
  h.s.setSource({ channel: 'stable' });
  assert.equal(h.updater.allowPrerelease, false);
});

test('automatic checks off: no timer, focus checks nothing, "Check now" still asks', async () => {
  const h = service({ autoCheck: false }, { version: null });
  h.s.start(10);
  assert.deepEqual(h.clock.pending(), []);
  await h.s.checkIfDue();
  assert.equal(h.calls.check, 0);
  assert.equal((await h.s.check()).status, 'current');
  assert.equal(h.calls.check, 1);
  assert.deepEqual(h.clock.pending(), [], 'a manual check arms no recurring timer');
  h.s.setSource({ autoCheck: true });
  assert.equal(h.clock.pending().length, 1, 'turning it on arms the next check');
  h.s.setSource({ autoCheck: false });
  assert.deepEqual(h.clock.pending(), []);
});

test('an offered version that is not newer (or a prerelease on stable) counts as up to date', async () => {
  for (const version of ['0.3.4', '0.3.3', '0.3.5-beta.1']) {
    const h = service(undefined, { version });
    assert.equal((await h.s.check()).status, 'current', version);
  }
  const beta = service({ channel: 'prerelease' }, { version: '0.3.5-beta.1' });
  assert.equal((await beta.s.check()).status, 'available');
});

test('the release notes and title of an offered update reach the state (for the notice)', async () => {
  const h = service();
  h.updater.checkForUpdates = async () => { h.emit('update-available', { version: '0.3.5', releaseName: 'Autark 0.3.5', releaseNotes: '<p>Fork updates</p>' }); return null; };
  const state = await h.s.check();
  assert.equal(state.releaseName, 'Autark 0.3.5');
  assert.equal(state.releaseNotes, 'Fork updates');
  assert.equal(showsNotice(state, null), true);
  assert.equal(showsNotice(state, '0.3.5'), false, '"Later" hides this version');
  assert.equal(showsNotice({ ...state, availableVersion: '0.3.6' }, '0.3.5'), true, 'a newer one shows again');
  assert.equal(showsNotice({ ...state, status: 'downloading' }, null), false);
});

test('the settings page: source choice and when "Check now" works', () => {
  assert.equal(sourceChoice('desquerteur/OpenAutark'), 'fork');
  assert.equal(sourceChoice('Teydra/OpenAutark'), 'upstream');
  assert.equal(sourceChoice('someone/else'), 'custom');
  const base: UpdateState = { status: 'current', version: '0.3.4', percent: 0, automaticInstall: true };
  assert.equal(canCheckNow(base), true);
  for (const status of ['development', 'checking', 'downloading', 'downloaded', 'installing'] as const) assert.equal(canCheckNow({ ...base, status }), false, status);
});

test('IPC: the source patch accepts owner/name, the two channels and a flag – nothing else', () => {
  assert.deepEqual(updateSourcePatch({ repository: ' https://github.com/teydra/OpenAutark ', channel: 'prerelease', autoCheck: false }), { repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false });
  assert.deepEqual(updateSourcePatch({}), {});
  assert.throws(() => updateSourcePatch({ repository: 'x' }), /owner\/name/);
  assert.throws(() => updateSourcePatch({ channel: 'nightly' }));
  assert.throws(() => updateSourcePatch({ autoCheck: 'yes' }));
  assert.throws(() => updateSourcePatch({ url: 'https://evil.example' }));
  assert.throws(() => updateSourcePatch(null));
  assert.throws(() => updateSourcePatch(['teydra/OpenAutark']));
});

test('the stored source: defaults without a file, a round trip, a broken file means defaults', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'af019-'));
  try {
    assert.deepEqual(await loadUpdateSource(dir), DEFAULT_SOURCE);
    await saveUpdateSource(dir, { repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false });
    assert.deepEqual(JSON.parse(await readFile(sourceFile(dir), 'utf8')), { repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false });
    assert.deepEqual(await loadUpdateSource(dir), { repository: 'teydra/OpenAutark', channel: 'prerelease', autoCheck: false });
    await writeFile(sourceFile(dir), '{ broken');
    assert.deepEqual(await loadUpdateSource(dir), DEFAULT_SOURCE);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
