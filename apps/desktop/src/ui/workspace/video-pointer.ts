// "Comment at 0:12.4": the pointer to a moment of a video that goes into a chat's draft, in media.look's clock so agents
// read it back. "[intro_v2.mp4 @ 0:12.4] " – with the id's start when another clip has the same name or the name was cut.
// Owns: that text. Never: the DOM, a player or a draft.

export interface PointerClip { fileId: string; name: string }

const POINTER_NAME_MAX = 80;
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]+/g;

/** "0:00.0", "0:12.4", "1:02:03.4" – the same as media.look's clock(). */
export function pointLabel(ms: number): string {
  const tenths = Math.max(0, Math.round(ms / 100));
  const seconds = `${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
  const minutes = Math.floor(tenths / 600) % 60;
  const hours = Math.floor(tenths / 36_000);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}

/** A name that keeps the pointer's format: one line, no brackets or " @ ", at most 80 characters. */
function pointerName(name: string): string {
  const clean = name.replace(INVISIBLE, ' ').replace(/\[/g, '(').replace(/\]/g, ')').replace(/\s*@\s*/g, '@').replace(/\s+/g, ' ').trim() || 'clip';
  const chars = [...clean];
  return chars.length > POINTER_NAME_MAX ? `${chars.slice(0, POINTER_NAME_MAX - 1).join('')}…` : clean;
}

export function pointerText(clip: PointerClip, ms: number, all: readonly PointerClip[]): string {
  const name = pointerName(clip.name);
  const ambiguous = name.endsWith('…') || all.some((other) => other.fileId !== clip.fileId && pointerName(other.name) === name);
  return `[${name} @ ${pointLabel(ms)}${ambiguous ? ` · ${clip.fileId.slice(0, 8)}` : ''}] `;
}

/** The draft with the pointer added: alone, right after trailing whitespace, else on a new line. */
export function joinPointer(draft: string, pointer: string): string {
  if (!draft) return pointer;
  return /\s$/.test(draft) ? `${draft}${pointer}` : `${draft}\n${pointer}`;
}
