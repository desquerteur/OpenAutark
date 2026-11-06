// The learned words (settings.json voice.vocabulary): names and terms the recognizers should know. The person or
// the AI adds them to the list (newest at the end); they go to a transcription service as its prompt, to
// realtime voice as its transcription hint and to the call talker. Older settings files hold entries as {term, …}: read as the term.
// Owns: reading the list, adding to it (withWords) and the form a word is kept in (wordOf). Never: stores it or
// learns words by itself.

/** The longest learned word a recognizer is given. */
export const WORD_CHARS = 80;
/** As many learned words as settings.json keeps (settings/validate.ts, the Settings word list). */
export const MAX_WORDS = 1000;

/** A word as it is kept and sent: spaces and control characters as one space, trimmed. */
export const wordOf = (word: string): string => word.replace(/[\s\u0000-\u001f]+/g, ' ').trim();

/** The learned words, newest first, trimmed and without duplicates. */
export function vocabularyWords(list: unknown): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(list) ? [...list].reverse() : []) {
    const raw = typeof entry === 'string' ? entry : (entry as { term?: unknown } | null)?.term;
    const word = typeof raw === 'string' ? wordOf(raw) : '';
    if (word && word.length <= WORD_CHARS && !out.includes(word)) out.push(word);
  }
  return out;
}

/** The list with these words as the newest: one already there, in any case, moves to the end in the new spelling; past MAX_WORDS the oldest go (only the newest ~800 characters are ever sent). */
export function withWords(list: readonly string[], words: readonly string[]): string[] {
  const added = words.map(wordOf)
    .filter((word, index, all) => word && word.length <= WORD_CHARS && all.findIndex((other) => other.toLowerCase() === word.toLowerCase()) === index);
  const lower = new Set(added.map((word) => word.toLowerCase()));
  return [...list.filter((word) => !lower.has(wordOf(word).toLowerCase())), ...added].slice(-MAX_WORDS);
}

/** The learned words as one recognizer prompt ("Teydra, FastConformer, …"), at most `max` characters. */
export function vocabularyPrompt(list: unknown, max = 800): string | undefined {
  let prompt = '';
  for (const word of vocabularyWords(list)) {
    const next = prompt ? `${prompt}, ${word}` : word;
    if (next.length > max) break;
    prompt = next;
  }
  return prompt || undefined;
}
