// The reading voices of Settings › Models › Voice: which of this device's voices
// are offered (those for the profile language, all when none match) and what the panel says about
// the stored voice.ttsVoice. The notes follow speakReply (chat/composer/conversation-audio.ts),
// which looks the stored name up in ALL of the device's voices, not only the offered ones.
// Owns: the language filter and the note conditions. Never: reads speechSynthesis or settings.

export interface VoiceLike { name: string; lang: string }

export interface VoiceChoice<V extends VoiceLike> {
  /** The voices the Select lists. */
  offered: V[];
  /** The stored voice is not on this device: replies are read with the default voice. */
  missing: boolean;
  /** The stored voice is on this device but not for the profile language: replies still use it. */
  otherLanguage: boolean;
}

export function voiceChoice<V extends VoiceLike>(all: readonly V[], language: string | undefined, stored: string | undefined): VoiceChoice<V> {
  const prefix = (language ?? '').toLowerCase().split('-')[0];
  const matching = prefix ? all.filter((voice) => voice.lang.toLowerCase().startsWith(prefix)) : [...all];
  const offered = matching.length ? matching : [...all];
  const installed = Boolean(stored) && all.some((voice) => voice.name === stored);
  return {
    offered,
    missing: Boolean(stored) && all.length > 0 && !installed,
    otherLanguage: installed && !offered.some((voice) => voice.name === stored),
  };
}
