// Electron window check of B-058 against the owner's complaint ("dictation only produced 'Hallo'") – the REAL path end
// to end in an isolated test profile with the demo engine, this PC's speech models and Chromium's fake microphone
// (--use-file-for-fake-audio-capture, no --use-fake-ui-for-media-stream: the app's own media arming still decides):
//   1. dictation, two takes: the composer's Dictate → the fake microphone plays "Hallo." + 1.5 s pause + one long
//      sentence (owner_16k.wav) → Stop → the take (16 kHz WAV) goes to FastConformer German (voice.localStt) → the
//      composer holds the text: WER ≤ 15 % against the reference, and the words after the first pause are there (not just
//      "Hallo"). Measured per take: tap → main answered (getUserMedia called) → microphone open → Stop shown, and where in
//      the played recording the take begins (envelope alignment of the stored take) – the words before that are lost;
//   2. a voice message (webm/opus, recorded by this window's own MediaRecorder from de_16k.wav) sent in the chat reaches
//      the agent as a transcript (runtime → main → hidden analyzer decode → local model, G6): WER ≤ 15 %;
//   3. abilities.status with that profile: hear-speech ready "FastConformer German on this PC" (the rest reported);
//   4. media.listen without a listening model on a WAV in the chat: the local hearing report (G9).
// Needs real models and recordings (skipped without them – nothing here is faked):
//   WF_B058_AUDIO   folder with owner_16k.wav + owner.txt (de_16k.wav + de.txt for step 2, else owner_16k.wav again)
//   WF_B058_MODELS  folder(s) (path-delimited) of installed model folders: fastconformer-de-int8, silero-vad, ced-mini (optional)
// Run: node scripts/build.mjs && node --test test/ui/b058-dictation-window.test.mjs
//   SCREENSHOTS=<dir> keeps the screenshots; B058_RESULTS=<file> writes the measured numbers as JSON.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { connect } from '../e2e/lib/runtime-client.mjs';
import { onsetMs, pcm16, takeStart, wav, wer, words } from './fixtures/b058/audio.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const audioDir = process.env.WF_B058_AUDIO ? path.resolve(process.env.WF_B058_AUDIO) : '';
const modelDirs = (process.env.WF_B058_MODELS ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.resolve(dir));
const STT = 'fastconformer-de-int8';
const ready = Boolean(audioDir && existsSync(path.join(audioDir, 'owner_16k.wav')) && existsSync(path.join(audioDir, 'owner.txt'))
  && modelDirs.some((dir) => existsSync(path.join(dir, STT, '.installed.json'))));
const LEAD_S = 0.5; // silence before the recording: the microphone opens a moment before the tap's first block
const TAIL_S = 2.5; // silence after it: the person stops a little after the last word

/** Puts an installed model folder into the profile (hard links where possible – no second copy on a full disk). */
async function seed(id, speechDir) {
  for (const dir of modelDirs) {
    const from = path.join(dir, id);
    if (!existsSync(path.join(from, '.installed.json'))) continue;
    await mkdir(path.join(speechDir, id), { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (!entry.isFile()) continue; // test_wavs/ and the like are not part of an install
      const source = path.join(from, entry.name), target = path.join(speechDir, id, entry.name);
      await link(source, target).catch(() => copyFile(source, target));
    }
    return true;
  }
  return false;
}

const freeMb = () => Math.round(os.freemem() / 1048576);

test('B-058 live: dictation through the fake microphone, a voice message, abilities and local hearing in the real window', { skip: !ready && 'needs WF_B058_AUDIO and WF_B058_MODELS (real recordings and models)', timeout: 1_500_000 }, async (t) => {
  const results = { at: new Date().toISOString(), freeMbAtStart: freeMb() };
  const profile = await mkdtemp(path.join(os.tmpdir(), 'workforce-b058-'));
  const shots = process.env.SCREENSHOTS ? path.resolve(process.env.SCREENSHOTS) : path.join(profile, 'shots');
  await mkdir(shots, { recursive: true });
  const speechDir = path.join(profile, 'models', 'speech');
  assert.ok(await seed(STT, speechDir), 'FastConformer German seeded');
  results.seeded = { vad: await seed('silero-vad', speechDir), tagger: await seed('ced-mini', speechDir) };
  const owner = pcm16(readFileSync(path.join(audioDir, 'owner_16k.wav')), 'owner_16k.wav');
  const ownerText = readFileSync(path.join(audioDir, 'owner.txt'), 'utf8').trim();
  const silence = (seconds) => Buffer.alloc(2 * Math.round(owner.rate * seconds));
  const played = Buffer.concat([silence(LEAD_S), owner.data, silence(TAIL_S)]);
  const micFile = path.join(profile, 'microphone.wav');
  await writeFile(micFile, wav(owner.rate, played));
  const recordingS = owner.data.length / 2 / owner.rate;
  results.firstWordAtMs = onsetMs(played, owner.rate); // "Hallo" in the played file

  const launchedAt = Date.now();
  const app = await electron.launch({
    executablePath: electronPath, cwd: root, timeout: 300_000,
    args: [root, '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`],
    env: { ...process.env, WORKFORCE_TEST_DATA: profile, WORKFORCE_FAKE_ENGINE: '1', ELECTRON_ENABLE_LOGGING: '0' },
  });
  let rpc;
  const logs = async (pattern) => {
    const dir = path.join(profile, 'logs');
    const files = existsSync(dir) ? (await readdir(dir)).filter((name) => name.endsWith('.log')) : [];
    const lines = [];
    for (const name of files) lines.push(...(await readFile(path.join(dir, name), 'utf8')).split('\n').filter((line) => pattern.test(line)).map((line) => `${name}: ${line.slice(0, 300)}`));
    return lines.slice(-25);
  };
  t.after(async () => {
    if (process.env.B058_RESULTS) await writeFile(process.env.B058_RESULTS, JSON.stringify(results, null, 2)).catch(() => undefined);
    rpc?.close?.();
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.shell', { timeout: 120_000 });
  results.startupMs = Date.now() - launchedAt;
  await app.evaluate(({ BrowserWindow }) => { const [win] = BrowserWindow.getAllWindows(); win.setSize(1280, 820); });
  const shot = async (name, locator) => { await page.waitForTimeout(300); await (locator ?? page).screenshot({ path: path.join(shots, `${name}.png`) }); results.shots = [...(results.shots ?? []), `${name}.png`]; };
  const info = JSON.parse(await readFile(path.join(profile, 'runtime.json'), 'utf8'));
  rpc = await connect(info.port, info.token, 'cli');

  const local = await rpc.call('voice.localModels');
  results.engine = { ready: local.engine.ready, error: local.engine.error };
  assert.equal(local.engine.ready, true, `the local speech engine loads in this runtime (${local.engine.error ?? ''})`);
  await rpc.call('settings.update', { voice: { localStt: STT } });
  assert.equal((await rpc.call('settings.get')).voice.localStt, STT);
  const manager = (await rpc.call('agents.list')).find((agent) => agent.template === 'manager');
  const chat = await rpc.call('chats.create', { title: 'Dictation', agentIds: [manager.id] });
  await rpc.call('events.subscribe', { topics: ['chats', `chat:${chat.id}`] });
  const reply = (pattern, timeoutMs) => rpc.waitFor('message.updated', (m) => m.conversationId === chat.id && m.authorId === manager.id && m.state === 'final' && pattern.test(m.body), timeoutMs);
  // getUserMedia's call and answer (renderer timestamps): tap → main answered → microphone open → Stop shown
  await page.evaluate(() => {
    const devices = navigator.mediaDevices, original = devices.getUserMedia.bind(devices);
    window.__b058 = [];
    devices.getUserMedia = async (constraints) => { const entry = { called: Date.now() }; window.__b058.push(entry); const stream = await original(constraints); entry.open = Date.now(); return stream; };
  });

  await t.test('1 dictation: the whole take, not just "Hallo" (two takes)', async () => {
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    const composer = page.locator('.composer');
    await composer.waitFor({ timeout: 20_000 });
    const field = composer.locator('textarea.composer-input');
    results.takes = [];
    for (const n of [1, 2]) {
      await field.fill('');
      await field.click();
      const known = new Set((await rpc.call('media.list', { kind: 'audio' })).map((m) => m.fileId));
      const freeBefore = freeMb();
      const tappedAt = Date.now();
      await composer.locator('button[aria-label="Dictate"]').click();
      await composer.locator('button[aria-label="Stop dictation"]').waitFor({ timeout: 60_000 });
      const shownAt = Date.now();
      await page.waitForTimeout(Math.round((LEAD_S + recordingS / 2) * 1000));
      if (n === 1) await shot('b058-01-dictation-live', composer);
      const remaining = (LEAD_S + recordingS + TAIL_S - 0.5) * 1000 - (Date.now() - shownAt);
      if (remaining > 0) await page.waitForTimeout(Math.round(remaining));
      await composer.locator('button[aria-label="Stop dictation"]').click();
      const stoppedAt = Date.now();
      await page.waitForFunction((since) => Date.now() - since > 1000 && !document.querySelector('.composer [aria-label="Transcribing dictation"], .composer [aria-label="Starting dictation"]')
        && !!document.querySelector('.composer button[aria-label="Dictate"]'), stoppedAt, { timeout: 600_000, polling: 250 });
      const text = (await field.inputValue()).trim();
      const doneAt = Date.now();
      const gum = (await page.evaluate(() => window.__b058.at(-1))) ?? {};
      const band = (await page.locator('.status-host .status-note').allTextContents()).map((line) => line.trim()).filter(Boolean);
      const take = { n, text, freeMbBefore: freeBefore, freeMbAfter: freeMb(), band, transcribeMs: doneAt - stoppedAt, heldMs: stoppedAt - shownAt,
        tapToMainAnsweredMs: gum.called - tappedAt, microphoneOpenMs: gum.open - gum.called, openToStopShownMs: shownAt - gum.open, tapToStopShownMs: shownAt - tappedAt };
      results.takes.push(take);
      if (n === 1) { await shot('b058-02-composer-text', composer); await shot('b058-03-chat-with-dictation'); }
      const stored = (await rpc.call('media.list', { kind: 'audio' })).find((m) => !known.has(m.fileId) && /^Dictation .*\.wav$/.test(m.name));
      const read = stored && await rpc.call('files.read', { id: stored.fileId, maxBytes: 4_000_000 }).catch((error) => { take.readError = error.message; return null; });
      if (read) {
        const pcm = pcm16(Buffer.from(read.dataBase64, 'base64'), 'the take');
        take.stored = { name: stored.name, durationMs: Math.round((pcm.data.length / 2 / pcm.rate) * 1000), rate: pcm.rate };
        // where the take begins in the played file; the first word starts at results.firstWordAtMs
        if (pcm.rate === owner.rate) take.startsInRecordingAt = takeStart(pcm.data, played, owner.rate);
      }
      if (!text) t.diagnostic(`take ${n}: no text; band: ${JSON.stringify(band)}\n${(await logs(/voice|dictat|speech|transcri|denied|microphone/i)).join('\n')}`);
      take.wer = wer(ownerText, text);
      t.diagnostic(`take ${n}: tap→Stop shown ${take.tapToStopShownMs} ms (main ${take.tapToMainAnsweredMs}, mic ${take.microphoneOpenMs}, tap ${take.openToStopShownMs}), `
        + `take begins at ${take.startsInRecordingAt?.ms} ms of the played file (first word at ${results.firstWordAtMs} ms, r ${take.startsInRecordingAt?.r}), `
        + `text ${take.transcribeMs} ms after Stop, WER ${take.wer.wer} %: ${text}`);
      take.local = Boolean(stored);
      if (n === 1) { // a fresh profile compiles the Windows speech assembly first: when it was written (main's start waits for that probe)
        const dir = path.join(profile, 'speech');
        const dll = existsSync(dir) ? (await readdir(dir)).find((name) => name.endsWith('.dll')) : undefined;
        if (dll) take.windowsSpeechDllWrittenMsAfterTap = Math.round((await stat(path.join(dir, dll))).mtimeMs) - tappedAt;
      }
    }
    // every take measured first, then judged (a failing first take still tells how the second went)
    const ref = words(ownerText), afterPause = ref.slice(ref.indexOf('hallo') + 1);
    for (const take of results.takes) {
      const hyp = words(take.text);
      take.afterPause = { kept: afterPause.filter((word) => hyp.includes(word)).length, of: afterPause.length };
      take.hallo = hyp.includes('hallo');
    }
    for (const take of results.takes) {
      const hyp = words(take.text);
      assert.ok(take.local, `take ${take.n} went to this PC's model as a WAV (local backend; Windows speech uploads nothing)`);
      assert.notDeepEqual(hyp, ['hallo'], `take ${take.n}: the exact bug – only "Hallo"`);
      assert.ok(take.afterPause.kept >= 0.8 * afterPause.length, `take ${take.n}: the sentence after the first pause is there (${take.afterPause.kept}/${afterPause.length} words)`);
      assert.ok(ref.slice(-3).some((word) => hyp.slice(-6).includes(word)), `take ${take.n}: the last words before Stop are there`);
      assert.ok(take.wer.wer <= 15, `take ${take.n}: WER ${take.wer.wer} % ≤ 15 %`);
    }
  });

  await t.test('2 voice message (webm/opus) reaches the agent as a transcript', async () => {
    const source = existsSync(path.join(audioDir, 'de_16k.wav')) ? 'de' : 'owner';
    const reference = readFileSync(path.join(audioDir, `${source}.txt`), 'utf8').trim();
    const input = readFileSync(path.join(audioDir, `${source}_16k.wav`)).toString('base64');
    const recordedAt = Date.now();
    const note = await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(bytes.buffer);
      const destination = context.createMediaStreamDestination();
      const player = context.createBufferSource();
      player.buffer = buffer;
      player.connect(destination);
      const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' });
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      await context.resume();
      recorder.start(1000);
      player.start();
      await new Promise((resolve) => { player.onended = resolve; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      recorder.stop();
      await stopped;
      const state = context.state;
      await context.close();
      const out = new Uint8Array(await new Blob(chunks).arrayBuffer());
      let text = '';
      for (let i = 0; i < out.length; i += 0x8000) text += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return { b64: btoa(text), bytes: out.length, mime: recorder.mimeType, state, seconds: buffer.duration };
    }, input);
    const file = await rpc.call('files.upload', { name: 'Voice message.webm', mime: 'audio/webm', dataBase64: note.b64 });
    const sentAt = Date.now();
    await rpc.call('messages.send', { conversationId: chat.id, body: 'Voice message', attachments: [{ fileId: file.id }] });
    const heard = await reply(/\[Audio: Voice message\.webm\]/, 600_000);
    const body = heard.body;
    const transcript = (body.split('Transcript:\n')[1] ?? '').split(/\n\[|\n\n/)[0].trim();
    results.voiceNote = { source, bytes: note.bytes, mime: note.mime, contextState: note.state, seconds: note.seconds, recordMs: sentAt - recordedAt, replyMs: Date.now() - sentAt, transcript, freeMbAfter: freeMb() };
    await page.waitForTimeout(500);
    await shot('b058-04-voice-message-echo');
    if (!transcript) t.diagnostic(`no transcript in the turn input:\n${body.slice(0, 1500)}\n${(await logs(/media|analyzer|decode|transcri|speech/i)).join('\n')}`);
    assert.match(note.mime, /^audio\/webm/, 'a webm recording');
    assert.ok(!body.includes('Transcription is still running'), 'prepare() transcribed before the turn');
    const score = wer(reference, transcript);
    results.voiceNote.wer = score;
    t.diagnostic(`voice message ${note.bytes} B ${note.mime}, reply after ${results.voiceNote.replyMs} ms, WER ${score.wer} %: ${transcript}`);
    assert.ok(score.wer <= 15, `voice message WER ${score.wer} % ≤ 15 %`);
  });

  await t.test('3 abilities.status in this profile', async () => {
    const status = await rpc.call('abilities.status');
    results.abilities = status.map((a) => ({ id: a.id, state: a.state, source: a.source, action: a.action?.label, note: a.note }));
    t.diagnostic(`abilities: ${status.map((a) => `${a.id}=${a.state}${a.source ? ` (${a.source})` : ''}${a.action ? ` [${a.action.label}]` : ''}`).join('; ')}`);
    await page.evaluate(() => { location.hash = '#/settings/models'; });
    const group = page.locator('#settings-uses');
    await group.waitFor({ timeout: 20_000 });
    await group.locator('.use-row .use-dot:not(.pending)').last().waitFor({ timeout: 20_000 });
    await shot('b058-05-uses', group);
    const speech = status.find((a) => a.id === 'hear-speech');
    assert.equal(speech?.state, 'ready');
    assert.match(speech?.source ?? '', /^FastConformer German on this PC/);
    assert.match((await group.locator('.use-row', { hasText: 'Speech to text' }).locator('.set-row-control').textContent()) ?? '', /FastConformer German/);
  });

  await t.test('4 media.listen without a listening model: the local hearing report', async () => {
    // the WAV in this chat (an agent hears only media of its chats), the tool called in the same turn
    const file = await rpc.call('files.upload', { name: 'owner.wav', mime: 'audio/wav', dataBase64: readFileSync(path.join(audioDir, 'owner_16k.wav')).toString('base64') });
    await page.evaluate((id) => { location.hash = `#/chat/${id}`; }, chat.id);
    const askedAt = Date.now();
    await rpc.call('messages.send', { conversationId: chat.id, body: `Hear it [[tool:media.listen ${JSON.stringify({ fileId: file.id, question: 'What do you hear?' })}]]`, attachments: [{ fileId: file.id }] });
    const heard = await reply(/media\.listen → /, 600_000);
    const output = heard.body.split('media.listen → ')[1] ?? '';
    results.listen = { ms: Date.now() - askedAt, output: output.slice(0, 2000), freeMbAfter: freeMb() };
    await page.waitForTimeout(500);
    await shot('b058-06-listen-report');
    t.diagnostic(`media.listen (${results.listen.ms} ms): ${output.slice(0, 1200)}`);
    assert.match(output, /"heardBy":\s*"this PC/, 'heard on this PC');
    assert.match(output, /"loudness":/, 'the loudness of the take');
    // the demo engine echoes at most 2000 characters of a tool's output: a cut transcript is scored on its visible part
    const closed = output.match(/"transcript":\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    const visible = closed ?? output.match(/"transcript":\s*"((?:[^"\\]|\\.)*)$/)?.[1] ?? '';
    const seen = closed ? words(visible) : words(visible).slice(0, -1);
    assert.ok(seen.length >= 5, `the report has the transcript (${visible.slice(0, 80)})`);
    results.listen.wer = { ...wer(closed ? ownerText : words(ownerText).slice(0, seen.length).join(' '), seen.join(' ')), cut: !closed };
    assert.ok(results.listen.wer.wer <= 15, `the report's transcript WER ${results.listen.wer.wer} % ≤ 15 %`);
  });

  results.rendererErrors = errors.filter((text) => !/Autofill|DevTools|Electron Security Warning/i.test(text));
  t.diagnostic(`screenshots: ${shots}`);
  assert.deepEqual(results.rendererErrors, [], 'no renderer errors');
});
