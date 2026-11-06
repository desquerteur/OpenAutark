// `record` ask widget: audio, video or screen recorder; with a `script` it becomes a
// teleprompter (large text; a short script gets a box as tall as its text, a long one scrolls
// while recording with adjustable speed, tap to pause).
// Flow: instructions → Start (preview) → Record → Stop → playback → Retake / Send.
// F07: the preview offers the camera/microphone choice when there is more than one
// (RecordDevice.tsx); an unsent take from an earlier visit comes back with "Resume unsent
// recording" (or Discard) before anything else. Until the recorder really records (recorder.ts:
// started) the status says "Starting…" with a still dot; the red dot and the time come after.
// Answer: {file: fileId, name, mime, seconds, size}. Owns: the recording UI and upload.
// Never: records without a click, or keeps the camera/mic on after a take.

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Button, IconButton } from '../../lib/ui.tsx';
import { toastError } from '../../lib/toasts.ts';
import { duration } from '../ask.ts';
import { uploadBlob } from '../host.ts';
import { Markdown } from '../markdown.tsx';
import type { AskWidgetProps } from './ask-types.ts';
import { PROMPTER_SPEEDS, prompterScrolls, prompterStep } from './prompter.ts';
import { canRecordLive, useRecorder } from './recorder.ts';
import type { RecordMode } from './recorder.ts';
import { RecordDevice } from './RecordDevice.tsx';
import { s, strings } from './util.ts';

const START_LABEL: Record<RecordMode, string> = { audio: 'Start microphone', video: 'Start camera', screen: 'Choose screen' };

function extensionOf(mime: string): string {
  if (mime.includes('mp4')) return mime.startsWith('audio') ? 'm4a' : 'mp4';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('quicktime')) return 'mov';
  return 'webm';
}

/** Script text: as tall as it is (min three lines); a long one scrolls while `running`, tap pauses. */
function Teleprompter(props: { script: string; bullets: string[]; running: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [scrolls, setScrolls] = useState(false);

  // Does the script fit the box at its maximum height? Re-checked when text or sizes change.
  useLayoutEffect(() => {
    const el = box.current;
    const text = content.current;
    if (!el || !text) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      setScrolls(prompterScrolls(text.offsetHeight, parseFloat(style.maxHeight), paddingY));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    observer.observe(el);
    return () => observer.disconnect();
  }, [props.script, props.bullets.join('\n')]);

  useEffect(() => {
    if (!props.running || paused || !scrolls) return;
    let frame = 0;
    let last = performance.now();
    let position = box.current?.scrollTop ?? 0;
    const step = (now: number) => {
      const el = box.current;
      if (!el) return;
      if (Math.abs(el.scrollTop - position) > 2) position = el.scrollTop; // the human scrolled
      const end = el.scrollHeight - el.clientHeight;
      position = prompterStep(position, PROMPTER_SPEEDS[speed], now - last, end);
      el.scrollTop = position;
      last = now;
      if (position < end) frame = requestAnimationFrame(step); // stops at the end (no idle frames)
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [props.running, paused, speed, scrolls]);
  useEffect(() => { if (!props.running) setPaused(false); }, [props.running]);
  return (
    <div class="w-prompter">
      <div ref={box} class={`w-prompter-text${paused ? ' is-paused' : ''}${scrolls ? '' : ' is-static'}`} role="document" aria-label="Script"
        onClick={() => { if (props.running && scrolls) setPaused(!paused); }}>
        <div ref={content}>
          {props.script && <Markdown text={props.script} />}
          {props.bullets.length > 0 && <ul>{props.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}</ul>}
        </div>
        {scrolls && <div class="w-prompter-end" aria-hidden="true" />}
      </div>
      {scrolls && (
        <div class="w-prompter-controls" role="group" aria-label="Scroll speed">
          <IconButton icon="caret-down" label="Slower" size="small" disabled={speed === 0} onClick={() => setSpeed(Math.max(0, speed - 1))} />
          <span class="tabular">{speed + 1}</span>
          <IconButton icon="caret-up" label="Faster" size="small" disabled={speed === PROMPTER_SPEEDS.length - 1} onClick={() => setSpeed(Math.min(PROMPTER_SPEEDS.length - 1, speed + 1))} />
          {props.running && <button type="button" class="text-button" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>}
        </div>
      )}
    </div>
  );
}

function Preview(props: { stream: MediaStream | null; mirrored: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = props.stream;
    if (props.stream) void el.play().catch(() => undefined);
  }, [props.stream]);
  return <video ref={ref} class={`w-record-preview${props.mirrored ? ' is-mirrored' : ''}`} muted playsInline autoplay />;
}

export function RecordWidget(props: AskWidgetProps) {
  const { block } = props;
  const mode: RecordMode = s(block.mode) === 'video' || s(block.mode) === 'screen' ? (s(block.mode) as RecordMode) : 'audio';
  const maxSeconds = typeof block.maxSeconds === 'number' && block.maxSeconds > 0 ? block.maxSeconds : undefined;
  const camera = s(block.camera) || 'any';
  const script = s(block.script);
  const bullets = strings(block.bullets);
  const rec = useRecorder(mode, { camera, maxSeconds, draftKey: props.draftKey });
  const [progress, setProgress] = useState<number | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const live = canRecordLive(mode);
  const recording = rec.state === 'recording';
  const starting = recording && !rec.started;
  const resumable = rec.state === 'idle' ? rec.resumable : null;
  const showPrompter = (script || bullets.length > 0) && rec.state !== 'recorded' && !resumable;
  // A selfie view is mirrored; a camera facing away (or asked for as 'back') is not.
  const mirrored = mode === 'video' && (rec.facing ? rec.facing === 'user' : camera !== 'back');

  const send = async () => {
    const take = rec.take;
    if (!take) return;
    if (typeof block.maxBytes === 'number' && take.blob.size > block.maxBytes) {
      toastError(new Error('This recording is too large. Record a shorter take.'), 'Upload failed');
      return;
    }
    setProgress(0);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const name = take.blob instanceof File && take.blob.name ? take.blob.name : `recording-${stamp}.${extensionOf(take.mime)}`;
      const ref = await uploadBlob(take.blob, name, setProgress);
      const ok = await props.submit({ file: ref.id, name: ref.name || name, mime: take.mime, seconds: Math.round(take.seconds), size: ref.size });
      if (ok) rec.reset();
    } catch (error) {
      toastError(error, 'Upload failed');
    } finally {
      setProgress(null);
    }
  };

  const pickFile = () => picker.current?.click();
  const accept = mode === 'audio' ? 'audio/*' : 'video/*';

  return (
    <div class={`w-record mode-${mode}`}>
      {block.instructions !== undefined && rec.state === 'idle' && <Markdown text={s(block.instructions)} class="w-details" />}
      {resumable && <p class="w-record-resume tabular" role="status">Unsent recording · {duration(resumable.seconds)}</p>}
      {showPrompter && <Teleprompter script={script} bullets={bullets} running={recording && rec.started} />}
      {mode !== 'audio' && (rec.state === 'ready' || recording) && <Preview stream={rec.stream} mirrored={mirrored} />}
      {rec.state === 'recorded' && rec.take && (
        mode === 'audio' || rec.take.mime.startsWith('audio/')
          ? <audio class="w-record-playback" src={rec.take.url} controls preload="metadata" />
          : <video class="w-record-playback" src={rec.take.url} controls playsInline preload="metadata" />
      )}
      {(recording || rec.state === 'recorded') && (
        <div class="w-record-status tabular" role="status">
          {recording && <span class={`w-record-dot${starting ? ' is-starting' : ''}`} aria-hidden="true" />}
          <span>{starting ? 'Starting…' : duration(recording ? rec.elapsed : rec.take?.seconds ?? 0)}</span>
          {recording && rec.started && maxSeconds && <span class="muted"> / {duration(maxSeconds)}</span>}
        </div>
      )}
      {rec.error && <p class="w-record-error" role="alert">{rec.error}</p>}
      {progress !== null && <div class="w-thin-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${progress * 100}%` }} /></div>}
      <div class="w-actions">
        {resumable && (
          <>
            <Button variant="primary" icon="arrow-counter-clockwise" onClick={rec.resume}>Resume unsent recording</Button>
            <Button variant="ghost" onClick={rec.forget}>Discard</Button>
          </>
        )}
        {!resumable && (rec.state === 'idle' || rec.state === 'error') && (
          <>
            {live && <Button variant="primary" icon={mode === 'audio' ? 'microphone' : mode === 'video' ? 'camera' : 'monitor'} onClick={() => void rec.prepare()}>{START_LABEL[mode]}</Button>}
            {mode !== 'screen' && <Button variant={live ? 'secondary' : 'primary'} onClick={pickFile}>{live ? 'Choose file' : mode === 'audio' ? 'Record audio' : 'Record video'}</Button>}
          </>
        )}
        {rec.state === 'preparing' && <Button variant="primary" busy>{START_LABEL[mode]}</Button>}
        {rec.state === 'ready' && (
          <>
            <Button variant="primary" onClick={rec.start}>Record</Button>
            <Button variant="ghost" onClick={rec.reset}>Cancel</Button>
            {mode !== 'screen' && <RecordDevice mode={mode} choice={rec.devices} onChoose={rec.chooseDevice} />}
          </>
        )}
        {recording && <Button variant="primary" icon="stop" onClick={rec.stop}>Stop</Button>}
        {rec.state === 'recorded' && (
          <>
            <Button variant="primary" busy={props.busy || progress !== null} onClick={() => void send()}>Send</Button>
            <Button variant="secondary" disabled={props.busy || progress !== null} onClick={() => void (live ? rec.retake() : (rec.reset(), pickFile()))}>Retake</Button>
          </>
        )}
      </div>
      <input ref={picker} type="file" hidden accept={accept} {...{ capture: mode === 'video' && camera === 'back' ? 'environment' : 'user' }}
        onChange={(event) => { const el = event.currentTarget as HTMLInputElement; const file = el.files?.[0]; el.value = ''; if (file) void rec.takeFile(file); }} />
    </div>
  );
}
