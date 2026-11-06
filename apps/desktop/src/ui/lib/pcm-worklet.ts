// D13: the microphone tap as an AudioWorklet (bundled on its own by scripts/build.mjs to
// app/ui/pcm-worklet.js – the app CSP's script-src 'self' allows addModule from app://app). It runs
// on the audio rendering thread, so a busy UI never drops blocks (the ScriptProcessorNode it
// replaces ran on the main thread); it collects `blockFrames` frames of channel 0 and posts each
// block (a transferred Float32Array) to its port. lib/microphone.ts imports the processor name
// and module path from here; the registration runs only inside the worklet scope.
// Owns: the processor. Never: encodes, sends or keeps audio beyond one block.

/** The registered processor name and the module's path next to index.html. */
export const PCM_TAP = 'workforce-pcm-tap';
export const PCM_TAP_MODULE = 'pcm-worklet.js';

interface WorkletScope {
  registerProcessor?(name: string, processor: new (options?: { processorOptions?: { blockFrames?: number } }) => unknown): void;
  AudioWorkletProcessor?: new () => { readonly port: MessagePort };
}

/** Defines and registers the processor in an AudioWorkletGlobalScope (no-op anywhere else). */
export function registerPcmTap(scope: WorkletScope = globalThis as unknown as WorkletScope): boolean {
  const Base = scope.AudioWorkletProcessor;
  if (typeof scope.registerProcessor !== 'function' || !Base) return false;
  class PcmTap extends Base {
    private readonly size: number;
    private block: Float32Array;
    private filled = 0;

    constructor(options?: { processorOptions?: { blockFrames?: number } }) {
      super();
      this.size = Math.max(128, Math.min(16_384, Math.floor(options?.processorOptions?.blockFrames ?? 512)));
      this.block = new Float32Array(this.size);
    }

    process(inputs: Float32Array[][]): boolean {
      const channel = inputs[0]?.[0];
      if (!channel) return true;
      let offset = 0;
      while (offset < channel.length) {
        const take = Math.min(this.size - this.filled, channel.length - offset);
        this.block.set(channel.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled === this.size) {
          const full = this.block;
          this.block = new Float32Array(this.size);
          this.filled = 0;
          this.port.postMessage(full, [full.buffer]);
        }
      }
      return true;
    }
  }
  scope.registerProcessor(PCM_TAP, PcmTap);
  return true;
}

registerPcmTap();
