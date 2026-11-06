// B-047 D14: plain audio for local speech – reading a WAV recording (PCM 8/16/24/32-bit or 32-bit float,
// WAVE_FORMAT_EXTENSIBLE too, any channel count mixed down to mono), raw PCM16 LE, band-limited
// resampling (windowed sinc, so 48 kHz → 16 kHz keeps no aliasing) and writing PCM16 WAV. The runtime's
// local recognizer feeds on 16 kHz mono floats; a page may encode its take with encodeWav before upload.
// Owns: these conversions. Never: I/O, decoding compressed formats (webm, ogg, mp3 stay with a service).

export interface MonoAudio { samples: Float32Array; sampleRate: number }

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/** A WAV file's audio as mono floats in [-1, 1]; throws an Error naming what is unsupported. */
export function parseWav(bytes: Uint8Array): MonoAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; size: number } | undefined;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === EXTENSIBLE && size >= 26 && body + 26 <= bytes.byteLength) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = { at: body, size: Math.min(size, bytes.byteLength - body) }; // a streamed WAV may claim more than it has
      break;
    }
    at = body + size + (size % 2);
  }
  if (!data || !channels || !sampleRate) throw new Error('a WAV file without audio');
  const float = format === FLOAT && bits === 32;
  if (!float && (format !== PCM || ![8, 16, 24, 32].includes(bits))) throw new Error(`unsupported WAV encoding (format ${format}, ${bits} bit)`);
  if (sampleRate < 4_000 || sampleRate > 192_000) throw new Error(`unsupported WAV sample rate ${sampleRate}`);
  const width = bits / 8;
  const frames = Math.floor(data.size / (width * channels));
  const out = new Float32Array(frames);
  const read = (offset: number): number => {
    if (float) return view.getFloat32(offset, true);
    if (bits === 8) return (bytes[offset] - 128) / 128;
    if (bits === 16) return view.getInt16(offset, true) / 32768;
    if (bits === 24) { const value = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); return ((value << 8) >> 8) / 8388608; }
    return view.getInt32(offset, true) / 2147483648;
  };
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) sum += read(data.at + (frame * channels + channel) * width);
    const value = sum / channels;
    out[frame] = value > 1 ? 1 : value < -1 ? -1 : value;
  }
  return { samples: out, sampleRate };
}

/** Raw PCM16 LE mono bytes as floats (an odd trailing byte is ignored). */
export function pcm16Samples(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let index = 0; index < out.length; index++) out[index] = view.getInt16(index * 2, true) / 32768;
  return out;
}

/** Zero crossings of the windowed sinc on each side (quality vs. time; 8 keeps the stop band well below speech). */
const ZEROS = 8;
/** Kernel table steps per input sample (the tap of a distance is looked up, not computed). */
const STEPS = 512;

/** Band-limited resampling (Hann-windowed sinc; below the lower Nyquist rate, so downsampling does not alias). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !samples.length) return samples;
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.97;
  const half = Math.ceil(ZEROS / cutoff);
  const kernel = new Float32Array(half * STEPS + 1);
  for (let step = 0; step < kernel.length; step++) {
    const x = step / STEPS;
    const arg = Math.PI * cutoff * x;
    kernel[step] = (arg === 0 ? 1 : Math.sin(arg) / arg) * (0.5 + 0.5 * Math.cos((Math.PI * x) / half));
  }
  const out = new Float32Array(Math.max(1, Math.round(samples.length * ratio)));
  for (let index = 0; index < out.length; index++) {
    const center = index / ratio;
    const first = Math.max(0, Math.floor(center) - half + 1);
    const last = Math.min(samples.length - 1, Math.floor(center) + half);
    let sum = 0;
    let weight = 0;
    for (let k = first; k <= last; k++) {
      const tap = kernel[Math.min(kernel.length - 1, Math.round(Math.abs(center - k) * STEPS))];
      sum += samples[k] * tap;
      weight += tap;
    }
    out[index] = weight ? sum / weight : 0;
  }
  return out;
}

/** Floats → PCM16 LE bytes (clipped). */
export function pcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    view.setInt16(index * 2, Math.round(value * 32767), true);
  }
  return out;
}

/** The part of a Web Audio AudioBuffer wavFromDecoded reads (no DOM types in the shared layer). */
export interface DecodedAudio { numberOfChannels: number; sampleRate: number; length: number; getChannelData(channel: number): Float32Array }

/** A page's decoded take (AudioContext.decodeAudioData of its webm/ogg) as a 16 kHz mono WAV for the local model. */
export function wavFromDecoded(audio: DecodedAudio, rate = 16_000): Uint8Array {
  const mono = new Float32Array(audio.length);
  for (let channel = 0; channel < audio.numberOfChannels; channel++) {
    const data = audio.getChannelData(channel);
    for (let index = 0; index < mono.length; index++) mono[index] += (data[index] ?? 0) / audio.numberOfChannels;
  }
  return encodeWav(resample(mono, audio.sampleRate, rate), rate);
}

/** A mono PCM16 WAV file of `samples`. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const pcm = pcm16Bytes(samples);
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < 4; i++) out[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + pcm.byteLength, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, PCM, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}
