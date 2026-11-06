// Device names another machine chose (a PC's name in a Remote request, a browser's own guess
// "Android · Chrome" in an access request) as plain one-line text, before they reach host-written
// to-dos, notifications, pushes and Settings. Such a name comes from whoever sent the request, so
// it must not add lines, Markdown (links, images, emphasis), HTML or invisible characters (bidi
// overrides, zero-width) to what the person checks before accepting.
// Owns: that one cleaning rule (runtime and UI share it). Never: decides whether a device is
// trusted (the key exchange does), or keeps the raw value anywhere.

/** Letters, marks, digits, spaces and a few separators remain; everything else is dropped. */
const DISALLOWED = /[^\p{L}\p{M}\p{N} ·.,'’()+-]/gu;
/** Controls, format characters (bidi, zero-width, tags) and line/paragraph separators. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** One line of plain text, at most `max` characters; '' when nothing readable is left. */
export function plainLabel(value: unknown, max = 60): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC')
    .replace(INVISIBLE, ' ')
    .replace(/_/g, ' ')
    .replace(DISALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}
