// D13: where dictated text goes into a draft. The field's caret or selection at the moment the
// mic was pressed is the target (a selection is replaced); a field that was not focused gets the
// text appended. Edits made while recording move the target with them (a prefix/suffix diff of
// the draft then and now: an edit before the target shifts it, one after leaves it, one that
// touched the selection makes the take append). The seam gets smart spacing (one space between
// words, none before punctuation or after an opening bracket/quote, a space before following text)
// and a capital letter where the text starts a sentence (never lowered: German nouns and names).
// Owns: these pure rules. Never: reads the DOM or the draft store (composer/voice.ts does).

/** The field's caret/selection when the take started; `focused` false: append. */
export interface DictationTarget { start: number; end: number; focused: boolean }

/** The result: the new draft text, where the dictated words begin in it, and the caret after them. */
export interface Inserted { text: string; offset: number; caret: number; dictated: string }

/** The common prefix and suffix lengths of two texts (non-overlapping). */
function diff(before: string, after: string): { prefix: number; suffix: number } {
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * The target in `after` for a target taken in `before` (edits while recording); null when an edit
 * touched the selection – the take is appended then. Typing at the caret itself moves it along.
 */
export function shiftTarget(before: string, after: string, target: DictationTarget): DictationTarget | null {
  if (before === after) return target;
  const { prefix, suffix } = diff(before, after);
  const editEnd = before.length - suffix; // the edit replaced before[prefix, editEnd)
  const delta = after.length - before.length;
  const start = Math.max(0, Math.min(target.start, before.length));
  const end = Math.max(start, Math.min(target.end, before.length));
  if (editEnd <= start) return { ...target, start: start + delta, end: end + delta }; // before it (typing at the caret, too)
  // Typed at the caret, but the diff placed it a little later ("offer| today" + " now" reads as "offer now| today"): slide it back.
  const inserted = after.slice(prefix, after.length - suffix);
  const slide = prefix - start;
  if (start === end && editEnd === prefix && slide > 0 && slide <= inserted.length && before.slice(start, prefix) === inserted.slice(inserted.length - slide)) {
    return { ...target, start: start + delta, end: end + delta };
  }
  if (prefix >= end) return { ...target, start, end }; // after it
  return null;
}

const OPENING = /[([{„“"'«‹¿¡]$/u;
const CLOSING = /^[.,;:!?)\]}»›…%]/u;
const SENTENCE_END = /(?:^|[.!?…]\s*|\n\s*)$/u;

/** `dictated` put into `text` at `target` (append when it is null or the field was not focused). */
export function insertDictation(text: string, target: DictationTarget | null, dictated: string): Inserted {
  let words = dictated.trim();
  const append = !target || !target.focused;
  const start = append ? text.length : Math.max(0, Math.min(target.start, text.length));
  const end = append ? text.length : Math.max(start, Math.min(target.end, text.length));
  if (!words) return { text, offset: start, caret: start, dictated: '' };
  let before = text.slice(0, start);
  const after = text.slice(end);
  if (SENTENCE_END.test(before)) words = words.charAt(0).toLocaleUpperCase() + words.slice(1);
  if (before && !/\s$/u.test(before) && !OPENING.test(before) && !CLOSING.test(words)) before += ' ';
  else if (/[ \t]$/u.test(before) && CLOSING.test(words)) before = before.replace(/[ \t]+$/u, ''); // "word ," → "word,"
  const gap = after && !/^\s/u.test(after) && !CLOSING.test(after) && !OPENING.test(words) ? ' ' : '';
  const offset = before.length;
  return { text: `${before}${words}${gap}${after}`, offset, caret: offset + words.length, dictated: words };
}
