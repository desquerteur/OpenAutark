// PCM16 LE mono sample-rate step for a realtime adapter whose provider takes 16 kHz microphone audio (Gemini Live)
// while devices send 24 kHz (shared/model/call.ts REALTIME_RATE). One resampler per session keeps the samples a chunk
// leaves over and the last sample, so chunk borders add no clicks; each pair of output samples is a short low-pass
// average of its three input samples (enough for speech recognition).
// Owns: that arithmetic. Never: buffers more than two samples, or touches sockets.

/** 24 kHz → 16 kHz, chunk by chunk (2 output samples per 3 input samples). */
export class Pcm24To16 {
  private carry: number[] = [];
  private prev = 0;

  push(pcm: Uint8Array): Uint8Array {
    const samples = [...this.carry];
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let at = 0; at + 1 < pcm.byteLength; at += 2) samples.push(view.getInt16(at, true));
    const whole = samples.length - (samples.length % 3);
    const out = new Uint8Array((whole / 3) * 4);
    const target = new DataView(out.buffer);
    for (let index = 0, write = 0; index < whole; index += 3, write += 4) {
      const [a, b, c] = [samples[index], samples[index + 1], samples[index + 2]];
      target.setInt16(write, clamp((this.prev + 2 * a + b) / 4), true);
      target.setInt16(write + 2, clamp((b + c) / 2), true);
      this.prev = c;
    }
    this.carry = samples.slice(whole);
    return out;
  }
}

const clamp = (value: number): number => Math.max(-32768, Math.min(32767, Math.round(value)));
