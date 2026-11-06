// One open microphone for dictation, voice conversations and realtime voice: the MediaStream (for a
// MediaRecorder) and, when asked, raw sample blocks. On the desktop it arms main's media gate itself
// (WorkforceDesktopApi.armMedia: the window may open the microphone for 15 s) right before it asks.
// D13: the blocks come from an AudioWorklet (lib/pcm-worklet.ts, bundled as its own file – the app
// CSP allows it as 'self'), so a busy UI
// thread never drops audio; a ScriptProcessorNode is the fallback where the worklet cannot load.
// A caller may ask for a sample rate (dictation: 16 kHz – the browser resamples with proper
// filtering); a device that refuses it gets its own rate (the caller's encoder resamples). The
// node outputs silence (muted gain), so nothing is played back. Blocks are pushed by the audio
// clock – there is no timer here.
// Owns: getUserMedia, the audio graph and their teardown. Never: encodes or sends audio
// (callers do, see lib/pcm.ts), never keeps the microphone open after close().

import { PCM_TAP, PCM_TAP_MODULE } from './pcm-worklet.ts';
import { bridge } from './platform.ts';

export interface Microphone {
  readonly stream: MediaStream;
  close(): void;
}

/** Called for every audio block with its sample rate (default ≈ 85 ms at 48 kHz). */
export type SampleListener = (samples: Float32Array, sampleRate: number) => void;

export interface MicrophoneOptions {
  /** The rate the blocks should have (the device's when it cannot be had). */
  sampleRate?: number;
  /** Block length in milliseconds (default: 4096 frames). */
  blockMs?: number;
}

const BLOCK = 4096;

/** Opens the microphone (armed first on the desktop). `onSamples` adds the processing graph; without it only the stream is opened. */
export async function openMicrophone(onSamples?: SampleListener, options: MicrophoneOptions = {}): Promise<Microphone> {
  // B-058 F2: the graph (context, worklet module) is readied while the device opens, so speech from
  // the moment it opens is not lost in a gap before the tap (0.4–5.8 s measured on a busy PC).
  const early = onSamples ? readyGraph(onSamples, options, options.sampleRate) : null;
  early?.catch(() => undefined); // awaited below
  let stream: MediaStream;
  try {
    await bridge?.armMedia(['audio']).catch(() => undefined);
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  } catch (error) {
    void early?.then((graph) => graph.dispose(), () => undefined);
    throw error;
  }
  if (!onSamples || !early) return { stream, close: () => stopTracks(stream) };
  let graph: Graph | null = null;
  try {
    graph = await early;
    let source: MediaStreamAudioSourceNode;
    try {
      source = graph.context.createMediaStreamSource(stream);
    } catch (error) {
      if (!options.sampleRate) throw error;
      graph.dispose(); // this device or browser cannot resample: its own rate
      graph = null;
      graph = await readyGraph(onSamples, options);
      source = graph.context.createMediaStreamSource(stream);
    }
    const { context, tap } = graph;
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(tap.node);
    tap.node.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    return {
      stream,
      close: () => {
        tap.stop();
        try { source.disconnect(); tap.node.disconnect(); mute.disconnect(); } catch { /* already gone */ }
        stopTracks(stream);
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    stopTracks(stream);
    graph?.dispose();
    throw error;
  }
}

interface Tap { node: AudioNode; stop(): void }
interface Graph { context: AudioContext; tap: Tap; dispose(): void }

/** A context at `sampleRate` when the browser allows it (else the device rate) with its tap; the stream is connected later. */
async function readyGraph(onSamples: SampleListener, options: MicrophoneOptions, sampleRate?: number): Promise<Graph> {
  let context: AudioContext | null = null;
  if (sampleRate) {
    try { context = new AudioContext({ sampleRate }); } catch { /* this device or browser cannot: its own rate */ }
  }
  const running = context ?? new AudioContext();
  try {
    const rate = running.sampleRate;
    const frames = options.blockMs ? Math.max(128, Math.round(rate * options.blockMs / 1000)) : BLOCK;
    const deliver = (samples: Float32Array) => {
      try { onSamples(samples, rate); } catch (error) { console.error('[workforce] audio block failed', error); }
    };
    const tap = await workletTap(running, frames, deliver) ?? processorTap(running, deliver);
    return { context: running, tap, dispose: () => { tap.stop(); void running.close().catch(() => undefined); } };
  } catch (error) {
    void running.close().catch(() => undefined);
    throw error;
  }
}

/** The AudioWorklet tap; null where the module cannot load (no worklet support, not served). */
async function workletTap(context: AudioContext, frames: number, deliver: (samples: Float32Array) => void): Promise<Tap | null> {
  if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return null;
  try {
    await context.audioWorklet.addModule(PCM_TAP_MODULE);
    const node = new AudioWorkletNode(context, PCM_TAP, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { blockFrames: frames } });
    node.port.onmessage = (event: MessageEvent) => { if (event.data instanceof Float32Array) deliver(event.data); };
    return { node, stop: () => { node.port.onmessage = null; node.port.close(); } };
  } catch (error) {
    console.warn('[workforce] audio worklet unavailable, using the script processor', error);
    return null;
  }
}

function processorTap(context: AudioContext, deliver: (samples: Float32Array) => void): Tap {
  const processor = context.createScriptProcessor(BLOCK, 1, 1);
  processor.onaudioprocess = (event) => deliver(event.inputBuffer.getChannelData(0));
  return { node: processor, stop: () => { processor.onaudioprocess = null; } };
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
