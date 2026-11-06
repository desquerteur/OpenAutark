// Media capture for the `record` widget: microphone, camera or screen → MediaRecorder → Blob.
// States: idle → preparing → ready (preview live) → recording → recorded (playback) → retake.
// Desktop arms the Electron media permission from the user gesture first; the PWA falls back
// to the OS recorder (<input capture>) when getUserMedia/MediaRecorder are missing or denied.
// F07: the camera/microphone comes from media-devices.ts (the remembered choice; a plugged-in
// camera is pre-selected and a live preview switches to it). While recording or holding an
// unsent take the widget holds the take guard (media-devices.ts heldTakes, read by For you).
// Each take recorded here (and a file picked in the PWA: a phone's OS recorder) is also kept in
// IndexedDB (pwa/idb.ts) under the widget's draft key until it is sent, retaken or discarded; a
// widget that unmounts mid-recording finishes the take there (recordTake), so the next mount
// offers "Resume unsent recording" (a mount right after waits for that save: unsentTake). Live
// device changes are handled only while a preview is open. A take counts from the recorder's
// 'start' event (Chromium fires it with the first written data, which can lag Record by a second
// or more while the encoder starts): until then the widget says "Starting…", not a running time.
// Owns: streams, the recorder, elapsed time, cleanup and the stored copy of the take.
// Never: uploads (the widget does) or keeps devices open longer than needed (tracks stop after
// each take and on unmount).

import { useEffect, useRef, useState } from 'preact/hooks';
import { bridge, platform } from '../../lib/platform.ts';
import { dropTake as dropStored, loadTake, saveTake } from '../../pwa/idb.ts';
import type { StoredTake } from '../../pwa/idb.ts';
import { deviceConstraint, holdTake, releaseTake, rememberedDevice, takeBusy, useDeviceChoice } from './media-devices.ts';
import type { CaptureMode } from './media-devices.ts';
import { openMediaStream } from './media-stream.ts';

export type RecordMode = 'audio' | 'video' | 'screen';
export type RecorderState = 'idle' | 'preparing' | 'ready' | 'recording' | 'recorded' | 'error';

export interface Take {
  blob: Blob;
  url: string;
  mime: string;
  seconds: number;
}

// VP8 before VP9: Chromium's software VP9 encoder took 2–7 s (longer on a busy PC) to its first
// data – that long "Starting…" after Record – and far more CPU while recording; VP8 starts at once.
const TYPES: Record<'audio' | 'video', string[]> = {
  audio: ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'],
  video: ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4'],
};

function pickType(kind: 'audio' | 'video'): string | undefined {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return undefined;
  return TYPES[kind].find((type) => MediaRecorder.isTypeSupported(type));
}

/** True when this browser can record live; otherwise the widget offers the OS recorder. */
export function canRecordLive(mode: RecordMode): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof navigator === 'undefined' || !navigator.mediaDevices) return false;
  if (mode === 'screen') return platform === 'desktop' || typeof navigator.mediaDevices.getDisplayMedia === 'function';
  return typeof navigator.mediaDevices.getUserMedia === 'function';
}

function friendlyError(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Access was not allowed.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No suitable device found.';
  if (name === 'NotReadableError') return 'The device is in use by another app.';
  return error instanceof Error && error.message ? error.message : 'Recording is not available.';
}

/**
 * Electron only grants media to the window shortly after an explicit arm: from the click that
 * opens a stream, or for the one kind a live preview lists again when a device change finds the
 * names withheld (media-devices.ts). For 'screen' main's display-media handler picks the
 * primary screen while video is armed.
 */
async function armMedia(kinds: CaptureMode[]): Promise<void> {
  try { await bridge?.armMedia?.(kinds); } catch { /* not on this host */ }
}

async function openStream(mode: RecordMode, camera: string, device: string | undefined): Promise<MediaStream> {
  await armMedia(mode === 'audio' ? ['audio'] : ['audio', 'video']);
  const open = (constraints: MediaStreamConstraints) => openMediaStream((value) => navigator.mediaDevices.getUserMedia(value), constraints);
  if (mode === 'audio') return open({ audio: { ...deviceConstraint(device), echoCancellation: true, noiseSuppression: true } });
  if (mode === 'video') {
    // A chosen camera wins over the block's front/back hint; the microphone is the one chosen for audio.
    const facingMode = camera === 'back' ? 'environment' : camera === 'front' ? 'user' : undefined;
    const pick = device ? deviceConstraint(device) : facingMode ? { facingMode } : {};
    const mic = rememberedDevice('audio');
    return open({ audio: mic ? deviceConstraint(mic) : true, video: { ...pick, width: { ideal: 1280 }, height: { ideal: 720 } } });
  }
  // Not the preload's capture.screen(): a PNG screenshot (shared/api/desktop.ts) cannot feed a recorder.
  return navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((track) => track.stop());
}

/** Reads a recorded/picked file's duration (seconds) from its metadata. */
export function mediaDuration(url: string, kind: 'audio' | 'video'): Promise<number> {
  return new Promise((resolve) => {
    const el = document.createElement(kind);
    el.preload = 'metadata';
    const done = (value: number) => { el.removeAttribute('src'); el.load(); resolve(Number.isFinite(value) ? value : 0); };
    el.onloadedmetadata = () => done(el.duration);
    el.onerror = () => done(0);
    el.src = url;
  });
}

/** The part of MediaRecorder a take uses (a fake in tests). */
export interface RecorderLike {
  readonly state: string;
  readonly mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onstop: ((event: Event) => void) | null;
  onstart?: ((event: Event) => void) | null;
  stop(): void;
}

/**
 * One take on a started recorder: its chunks become a Blob on stop, stored under `key` before
 * `onEnd` runs – also when the widget already left (unmount stops the recorder), so the next
 * mount offers "Resume unsent recording". An empty take is not stored. The promise settles once
 * the take is stored (or there was nothing to store). `onStart` runs once, when the recorder
 * really records (its 'start' event, or its first data where a browser fires none); the take's
 * seconds count from that 'start' event.
 */
export function recordTake(recorder: RecorderLike, options: { key?: string; type: string; now?: () => number; onStart?(): void; onEnd(blob: Blob, mime: string, seconds: number): void }): Promise<void> {
  const now = options.now ?? Date.now;
  let startedAt = now();
  let started = false;
  const begin = (at: number) => { if (started) return; started = true; startedAt = at; options.onStart?.(); };
  const chunks: Blob[] = [];
  recorder.onstart = () => begin(now());
  recorder.ondataavailable = (event) => { if (!event.data.size) return; chunks.push(event.data); begin(startedAt); };
  return new Promise<void>((stored) => {
    recorder.onstop = () => {
      const mime = recorder.mimeType || options.type;
      const blob = new Blob(chunks, { type: mime });
      const seconds = Math.max(0, (now() - startedAt) / 1000);
      const saved = blob.size && options.key ? saveTake(options.key, { blob, mime, seconds, at: now() }) : Promise.resolve();
      void saved.then(() => stored());
      options.onEnd(blob, mime, seconds);
    };
  });
}

/** Takes still being stored after their widget left mid-recording (by draft key); see unsentTake. */
const finishing = new Map<string, Promise<void>>();

/** A widget left while recording: `stored` (recordTake's promise) settles once the take is kept. */
export function leftMidTake(key: string, stored: Promise<void>): void {
  finishing.set(key, stored);
  void stored.then(() => { if (finishing.get(key) === stored) finishing.delete(key); });
}

/** The unsent take for "Resume unsent recording"; a mount right after leaving mid-take waits (up to 10 s) for it to be stored. */
export async function unsentTake(key: string): Promise<StoredTake | undefined> {
  const pending = finishing.get(key);
  if (pending) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, 10_000); })]);
    clearTimeout(timer);
  }
  return loadTake(key);
}

/** "Discard recording?" mid-take: the recorder stops and nothing of it is kept or stored. */
export function endUnsaved(recorder: RecorderLike): void {
  recorder.ondataavailable = null;
  recorder.onstop = null;
  recorder.onstart = null;
  if (recorder.state !== 'inactive') recorder.stop();
}

// ------------------------------------------------------------------ the hook

interface Live {
  stream: MediaStream | null;
  recorder: MediaRecorder | null;
  take: Take | null;
  timer: ReturnType<typeof setInterval> | null;
  gone: boolean;
  state: RecorderState;
  /** recordTake's promise for the take in progress. */
  stored: Promise<void> | null;
}

export function useRecorder(mode: RecordMode, options: { camera?: string; maxSeconds?: number; draftKey?: string }) {
  const key = options.draftKey;
  const camera = options.camera ?? 'any';
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [elapsed, setElapsed] = useState(0);
  /** The recorder really records (see recordTake); false while 'recording' waits for its start. */
  const [started, setStarted] = useState(false);
  const [take, setTake] = useState<Take | null>(null);
  const [resumable, setResumable] = useState<StoredTake | null>(null);
  const [facing, setFacing] = useState<string | undefined>(undefined);
  const live = useRef<Live>({ stream: null, recorder: null, take: null, timer: null, gone: false, state: 'idle', stored: null });
  const holder = useRef({}).current;

  const devices = useDeviceChoice(mode === 'screen' ? null : mode, {
    remembered: mode === 'audio' || camera === 'any',
    arm: armMedia,
    // A camera plugged in (or the chosen one unplugged) while the preview is live: switch to it.
    onSwitch: () => { if (live.current.state === 'ready') void prepare(); },
  });

  const moveTo = (next: RecorderState) => { live.current.state = next; setState(next); };
  const clearTimer = () => { if (live.current.timer) { clearInterval(live.current.timer); live.current.timer = null; } };
  /** The stream closes; device changes wait for the next preview. */
  const release = () => {
    clearTimer();
    devices.chooser?.pause();
    stopStream(live.current.stream);
    live.current.stream = null;
    setStream(null);
  };
  /** The take goes, and its stored copy with it. */
  const dropTake = () => {
    if (live.current.take) {
      URL.revokeObjectURL(live.current.take.url);
      if (key) void dropStored(key);
    }
    live.current.take = null;
    setTake(null);
  };
  const keepTake = (next: Take) => {
    live.current.take = next; setTake(next); setResumable(null); setError(null); moveTo('recorded');
  };

  // Everything is released when the widget goes away (navigation, answered, collapsed). A take
  // in progress is finished: its onstop keeps it in IndexedDB for "Resume unsent recording".
  useEffect(() => () => {
    const current = live.current;
    current.gone = true; // a permission prompt still open resolves after this: prepare() stops that stream
    clearTimer();
    if (current.recorder && current.recorder.state !== 'inactive') {
      if (key && current.stored) leftMidTake(key, current.stored);
      current.recorder.stop();
    }
    stopStream(current.stream);
    if (current.take) URL.revokeObjectURL(current.take.url);
  }, []);

  // An unsent take from an earlier visit (navigation, reload, restart).
  useEffect(() => {
    if (!key) return;
    let current = true;
    void unsentTake(key).then((stored) => { if (current && stored && live.current.state === 'idle' && !live.current.take) setResumable(stored); });
    return () => { current = false; };
  }, [key]);

  /** Drops everything without keeping it: the take, a take in progress and the stored copy. */
  const discard = (): void => {
    if (live.current.recorder) endUnsaved(live.current.recorder);
    live.current.recorder = null;
    dropTake();
    release();
    setResumable(null);
    setError(null);
    moveTo('idle');
    if (key) void dropStored(key);
  };

  const busy = takeBusy(state, take !== null);
  useEffect(() => {
    if (!key || !busy) return;
    holdTake(key, holder, discard);
    return () => releaseTake(key, holder);
  }, [key, busy]);

  const prepare = async (): Promise<void> => {
    setError(null);
    moveTo('preparing');
    release(); // never two open devices (a device switch reopens the preview)
    try {
      const next = await openStream(mode, camera, devices.chooser?.wanted());
      if (live.current.gone) { stopStream(next); return; } // widget left while the prompt was open
      stopStream(live.current.stream);
      live.current.stream = next;
      setStream(next);
      // Screen sharing can be ended from the browser/OS bar: treat it like Stop.
      next.getVideoTracks()[0]?.addEventListener('ended', () => { if (live.current.recorder?.state === 'recording') live.current.recorder.stop(); });
      const settings = (mode === 'audio' ? next.getAudioTracks() : next.getVideoTracks())[0]?.getSettings?.();
      setFacing(settings?.facingMode);
      void devices.chooser?.refresh(settings?.deviceId); // access is allowed now: device names are readable
      moveTo('ready');
    } catch (err) {
      if (live.current.gone) return;
      setError(friendlyError(err));
      moveTo('error');
    }
  };

  /** The person picked another camera or microphone: remembered, and a live preview follows. */
  const chooseDevice = (id: string): void => {
    devices.chooser?.choose(id);
    if (live.current.state === 'ready') void prepare();
  };

  const start = (): void => {
    const current = live.current.stream;
    if (!current) return;
    const kind = mode === 'audio' ? 'audio' : 'video';
    const mimeType = pickType(kind);
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(current, mimeType ? { mimeType } : undefined);
    } catch (err) {
      setError(friendlyError(err));
      moveTo('error');
      release();
      return;
    }
    let startedAt: number | null = null; // the time and maxSeconds count once the recorder records
    devices.chooser?.pause(); // no device switch mid-take
    live.current.stored = recordTake(recorder, {
      key, type: mimeType || `${kind}/webm`,
      onStart: () => {
        startedAt = Date.now();
        if (!live.current.gone) setStarted(true);
      },
      onEnd: (blob, type, seconds) => {
        clearTimer();
        live.current.recorder = null;
        if (live.current.gone) return; // left mid-recording: stored for "Resume unsent recording"
        release();
        if (!blob.size) { setError('Nothing was recorded.'); moveTo('error'); return; }
        keepTake({ blob, url: URL.createObjectURL(blob), mime: type, seconds });
      },
    });
    live.current.recorder = recorder;
    recorder.start(1000);
    setElapsed(0);
    setStarted(false);
    moveTo('recording');
    live.current.timer = setInterval(() => {
      if (startedAt === null) return; // "Starting…"
      const seconds = (Date.now() - startedAt) / 1000;
      setElapsed(seconds);
      if (options.maxSeconds && seconds >= options.maxSeconds && recorder.state === 'recording') recorder.stop();
    }, 500);
  };

  const stop = (): void => {
    const recorder = live.current.recorder;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  };

  /** Back to a fresh preview (drops the current take and its stored copy). */
  const retake = async (): Promise<void> => {
    dropTake();
    await prepare();
  };

  /**
   * Uses a file from the OS recorder / picker as the take. Only off the desktop is it stored: a
   * phone's camera app may keep it nowhere else, while a file picked on the PC stays on its disk.
   */
  const takeFile = async (file: File): Promise<void> => {
    dropTake();
    release();
    const url = URL.createObjectURL(file);
    const seconds = file.type.startsWith('audio/') || file.type.startsWith('video/') ? await mediaDuration(url, file.type.startsWith('audio/') ? 'audio' : 'video') : 0;
    const mime = file.type || 'application/octet-stream';
    if (key && platform !== 'desktop') void saveTake(key, { blob: file, mime, seconds, at: Date.now() });
    keepTake({ blob: file, url, mime, seconds });
  };

  /** "Resume unsent recording": the stored take becomes the take again (playback, Send, Retake). */
  const resume = (): void => {
    if (!resumable) return;
    release();
    keepTake({ blob: resumable.blob, url: URL.createObjectURL(resumable.blob), mime: resumable.mime, seconds: resumable.seconds });
  };

  /** "Discard" next to Resume: the stored take goes. */
  const forget = (): void => { setResumable(null); if (key) void dropStored(key); };

  /** After Send or Cancel: back to idle; a take (sent) leaves the store too. */
  const reset = (): void => {
    dropTake();
    release();
    setError(null);
    moveTo('idle');
  };

  return { state, error, stream, elapsed, started, take, facing, devices: devices.choice, resumable, chooseDevice, prepare, start, stop, retake, takeFile, resume, forget, reset };
}
