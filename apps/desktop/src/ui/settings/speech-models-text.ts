// The words of the local speech models, pure: a row of Settings › Models › "Speech models on this PC" – its hint
// (progress, a failed download, an engine that cannot run here, a model too big for this PC; then job, languages and
// size) and its one action ("42 %" → Use / "In use"; Download where it may be fetched) – and the runtime's own download as one status
// line ("Downloading the speech model · FastConformer German 42 %" with Open; a failed one can be dismissed).
// Owns: these texts and the row's state rule. Never: reads signals, calls the runtime or renders.

import type { LocalSpeechModel, LocalSpeechOffer, LocalSpeechPull } from '../../shared/model/local-speech-models.ts';
import { localSpeechModel } from '../../shared/model/local-speech-models.ts';
import type { Notice } from '../shell/notices.ts';

/** What a model does, as its row says it first. */
const JOB: Readonly<Record<string, string>> = { stt: 'Dictation', tts: 'Reading voice', tagging: 'Sound recognition' };
/** More languages than this read as a count. */
const MAX_NAMED = 4;
export const SPEECH_NOTICE_ID = 'speech-download';

let languageNames: Intl.DisplayNames | null | undefined;

/** "German", "English, German, Spanish, French", or "25 languages". */
export function languagesText(codes: readonly string[]): string {
  if (!codes.length) return '';
  if (codes.length > MAX_NAMED) return `${codes.length} languages`;
  if (languageNames === undefined) {
    try { languageNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch { languageNames = null; }
  }
  return codes.map((code) => languageNames?.of(code) ?? code).join(', ');
}

/** A pull's share, floored to whole percent (0 while the total is unknown). */
export function pullPercent(pull: Pick<LocalSpeechPull, 'done' | 'total'>): number {
  return pull.total > 0 ? Math.min(100, Math.max(0, Math.floor((pull.done / pull.total) * 100))) : 0;
}

/** A download that is still under way (downloading or unpacking). */
export const running = (pull: LocalSpeechPull | undefined): boolean => pull?.state === 'downloading' || pull?.state === 'unpacking';

/** A running pull in a few words: "Downloading 42 %" or "Unpacking…". */
export function progressText(pull: LocalSpeechPull): string {
  return pull.state === 'unpacking' ? 'Unpacking…' : `Downloading ${pullPercent(pull)} %`;
}

export interface SpeechRowInput {
  /** The catalog entry: the row exists before voice.localModels answers. */
  model: LocalSpeechModel;
  /** voice.localModels' row (fit, recommended, installed); undefined while not read or not offered. */
  offer?: LocalSpeechOffer;
  /** voice.localModels' engine; undefined while not read. */
  engine?: { ready: boolean; error?: string };
  /** voice.localStt / localTts names it. */
  chosen: boolean;
  /** The last 'voice.pull' event of this model. */
  pull?: LocalSpeechPull;
  /** This window may download (owner) and change voice settings. */
  canPull: boolean;
  canChoose: boolean;
}

export type SpeechPrimary = 'download' | 'progress' | 'use' | 'in-use';

export interface SpeechRowView {
  hint: string;
  recommended: boolean;
  primary: { kind: SpeechPrimary; label: string; disabled: boolean };
}

/** One local speech model's row (see the header). */
export function speechRowView(input: SpeechRowInput): SpeechRowView {
  const { model, offer, engine, pull } = input;
  const installed = offer?.installed === true;
  const busy = running(pull);
  const size = installed ? `${Math.round(model.sizeMb)} MB on this PC` : `${offer?.downloadMb ?? Math.round(model.download.bytes / 1_000_000)} MB download`;
  const status = busy ? progressText(pull!)
    : pull?.state === 'failed' ? pull.error || 'The download failed.'
      : engine && !engine.ready ? 'Cannot run on this PC'
        : !installed && offer?.fit === 'too-big' ? 'Too big for this PC' : undefined;
  const hint = [status, JOB[model.purpose], languagesText(model.languages), size].filter(Boolean).join(' · ');
  const primary: SpeechRowView['primary'] = busy ? { kind: 'progress', label: `${pullPercent(pull!)} %`, disabled: true }
    : installed && input.chosen ? { kind: 'in-use', label: 'In use', disabled: true }
      : installed ? { kind: 'use', label: 'Use', disabled: !input.canChoose }
        : { kind: 'download', label: 'Download', disabled: !input.canPull || !offer || engine?.ready !== true || offer.fit === 'too-big' };
  return { hint, recommended: offer?.recommended === true, primary };
}

/** What the status line says the runtime fetches, by the model's job. */
const FETCHING: Readonly<Record<string, string>> = { stt: 'Downloading the speech model', tts: 'Downloading the local voice', tagging: 'Downloading the sound recognizer' };

/**
 * The runtime's own downloads as one status line (see the header): the first running one, else the first failed
 * one (Dismiss forgets it), else null. A download the person started shows in its row, not here.
 */
export function speechPullNotice(pulls: readonly LocalSpeechPull[], priority: number, actions: { open: () => void; dismiss: (id: string) => void }): Notice | null {
  const own = pulls.filter((pull) => pull.auto === true);
  const open = [{ label: 'Open', title: 'Open Settings › Models', run: actions.open }];
  const now = own.find(running);
  if (now) {
    const model = localSpeechModel(now.id);
    const label = model?.label ?? now.id;
    const what = FETCHING[model?.purpose ?? 'stt'] ?? FETCHING.stt;
    const progress = now.state === 'unpacking' ? 'unpacking…' : `${pullPercent(now)} %`;
    return { id: SPEECH_NOTICE_ID, tone: 'info', text: `${what} · ${label} ${progress}`, detail: model?.note, actions: open, priority };
  }
  const failed = own.find((pull) => pull.state === 'failed');
  if (!failed) return null;
  const label = localSpeechModel(failed.id)?.label ?? failed.id;
  return {
    id: SPEECH_NOTICE_ID, tone: 'warn', text: failed.error || `${label} could not be downloaded.`,
    detail: `${label} can be downloaded again in Settings › Models.`, actions: open, priority, onDismiss: () => actions.dismiss(failed.id),
  };
}
