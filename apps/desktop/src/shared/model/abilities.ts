// B-058 G14: the abilities overview – each thing the AI can do (hear speech and sounds, see images and
// video, use websites and the PC, speak, make images, music, sound effects and video), whether it is ready
// on this PC, what provides it, and the one action that turns it on. The AI reads it, the use rows of Settings › Models
// take their state and action from it (models.uses); the runtime computes it (runtime/abilities/**, rpc 'abilities.status', handler runtime/rpc/handlers/abilities.ts).
// Owns: these shapes and the method's contract. Never: behaviour.

export type AbilityId =
  | 'hear-speech' | 'hear-sounds' | 'see-images' | 'see-video' | 'use-web' | 'use-pc'
  | 'speak' | 'make-images' | 'make-music' | 'make-sounds' | 'make-video';

/** Every ability in the order the overview lists them. */
export const ABILITY_IDS: readonly AbilityId[] = [
  'hear-speech', 'hear-sounds', 'see-images', 'see-video', 'use-web', 'use-pc',
  'speak', 'make-images', 'make-music', 'make-sounds', 'make-video',
];

/** 'ready': works now; 'setup': one action away (download a model, add a key); 'off': turned off or not possible here. */
export type AbilityState = 'ready' | 'setup' | 'off';

/**
 * The one action that turns an ability on: download a local model (`target` its id), or let the AI set it up
 * ('ai': `target` names what – a provider id or a settings section).
 */
export interface AbilityAction {
  kind: 'download-model' | 'ai';
  label: string;
  target?: string;
}

export interface Ability {
  id: AbilityId;
  state: AbilityState;
  /** What provides it, in a few words ('Canary 180M on this PC', 'ChatGPT plan via Codex'). */
  source?: string;
  action?: AbilityAction;
  /** One short line (a limit, why it is off). */
  note?: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    /** B-058 G14: every ability with its state, source and the action that turns it on (ABILITY_IDS order). */
    'abilities.status': { params: void; result: Ability[] };
    /** B-058 (T7): removes a downloaded local speech model from this PC (unchosen first; runtime/abilities/remove-model.ts). */
    'voice.removeLocal': { params: { id: string }; result: { ok: true } };
  }
}
