// This window's view of the local speech models: voice.localModels (read again when a download ends) and every
// 'voice.pull' progress event (a click's download and the runtime's own), shared by Settings › Models' speech models, the use rows
// of Settings › Models, the status line (registerSpeechPullNotice: the runtime's automatic download as one line) and the mic
// (lib/dictation.ts dictationNote: "Speech model downloading NN %"). Download is voice.pullLocal (the runtime
// chooses the model when it is there), Use is voice.localStt / localTts. Events only.
// Owns: these signals and actions. Never: the texts (speech-models-text.ts) or rendering.

import { signal } from '@preact/signals';
import type { LocalSpeechModels, LocalSpeechPull } from '../../shared/model/local-speech-models.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import { navigate } from '../lib/router.ts';
import { errorText, rpc } from '../lib/rpc.ts';
import { can } from '../lib/session.ts';
import { updateSettings } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { NOTICE_PRIORITY, registerNotice } from '../shell/notices.ts';
import { running, speechPullNotice } from './speech-models-text.ts';

/** voice.localModels: undefined while not read, null where this connection cannot read it or the runtime offers none. */
export const localModels = signal<LocalSpeechModels | null | undefined>(undefined);
/** The last 'voice.pull' event per model id. */
export const speechPulls = signal<Readonly<Record<string, LocalSpeechPull>>>({});
/** Counts finished downloads and choices: the use rows read models.uses again when it changes. */
export const speechChanges = signal(0);

let listening: (() => void) | undefined;
let reading: Promise<void> | undefined;
/** A read was asked for while one ran: its answer may predate the change (review fix) – read once more after it. */
let stale = false;

/** Reads voice.localModels again (one read at a time; a request during a read reads again after it). */
export function readLocalModels(): Promise<void> {
  if (!can('voice.localModels')) { localModels.value = null; return Promise.resolve(); }
  if (reading) { stale = true; return reading; }
  const once = (): Promise<void> => rpc.call('voice.localModels').then(
    (result) => { localModels.value = result; },
    () => { localModels.value = localModels.peek() ?? null; },
  ).then(() => {
    if (!stale) return;
    stale = false;
    return once();
  });
  reading = once().finally(() => { reading = undefined; });
  return reading;
}

/** Starts the one 'voice.pull' listener of this window (idempotent). */
export function watchSpeechPulls(): void {
  if (listening) return;
  listening = rpc.on('voice.pull', (event) => {
    if (!event?.id) return;
    speechPulls.value = { ...speechPulls.peek(), [event.id]: event };
    if (event.state === 'done' || event.state === 'failed') {
      speechChanges.value = speechChanges.peek() + 1;
      void readLocalModels();
    }
  });
}

/** A download of `id` is under way (downloading or unpacking). */
export function pulling(id: string | undefined, pulls: Readonly<Record<string, LocalSpeechPull>> = speechPulls.value): boolean {
  const state = id ? pulls[id]?.state : undefined;
  return state === 'downloading' || state === 'unpacking';
}

/** Download: voice.pullLocal (progress arrives as events; the runtime chooses the model once it is there). */
export async function pullModel(id: string): Promise<void> {
  watchSpeechPulls();
  if (pulling(id, speechPulls.peek())) return;
  speechPulls.value = { ...speechPulls.peek(), [id]: { id, state: 'downloading', done: 0, total: 0 } };
  try {
    await rpc.call('voice.pullLocal', { id });
    // review fix: the answer comes after the 'done' event; without that event (none reached this window) the row
    // would show "0 %" for good – it is there now
    const last = speechPulls.peek()[id];
    if (running(last)) {
      speechPulls.value = { ...speechPulls.peek(), [id]: { id, state: 'done', done: last!.total, total: last!.total } };
      speechChanges.value = speechChanges.peek() + 1;
      void readLocalModels();
    }
  } catch (error) {
    // the runtime's reason ("Not enough disk space for CED Mini: …"), else a plain line
    const reason = errorText(error) || `${localSpeechModel(id)?.label ?? id} could not be downloaded.`;
    speechPulls.value = { ...speechPulls.peek(), [id]: { id, state: 'failed', done: 0, total: 0, error: reason } };
    toastError(error, 'Download failed');
  }
}

/** Use: the downloaded model becomes the dictation model (localStt) or the reading voice (localTts). */
export async function useModel(id: string): Promise<void> {
  const model = localSpeechModel(id);
  if (!model || (model.purpose !== 'stt' && model.purpose !== 'tts')) return;
  try {
    await updateSettings({ voice: model.purpose === 'stt' ? { localStt: id } : { localTts: id } });
    speechChanges.value = speechChanges.peek() + 1;
  } catch (error) { toastError(error, 'Could not save the choice'); }
}

/** The runtime's own download as one status line; registered once per app start (shell/StatusLine.tsx). */
export function registerSpeechPullNotice(): () => void {
  watchSpeechPulls(); // a connection that gets no 'voice.pull' events shows nothing
  return registerNotice(() => speechPullNotice(Object.values(speechPulls.value), NOTICE_PRIORITY.setup, {
    open: () => navigate({ view: 'settings', section: 'models' }),
    dismiss: forgetPull,
  }));
}

/** Forgets the last event of `id` (a failed download's band line was dismissed). */
function forgetPull(id: string): void {
  const { [id]: _gone, ...rest } = speechPulls.peek();
  speechPulls.value = rest;
}
