// The line window of files.read (B-048 real test, 28.10.2026): a long text never comes back in one piece. Engines
// shorten long tool outputs themselves (Codex cuts the middle), so an agent that got a 131k-character log "in full"
// saw head and tail only and counted wrongly – and re-read it again and again. A file shows at most WINDOW_CHARS of
// whole lines from `fromLine`, and the last line says exactly which lines were shown and where to continue.
// Owns: the window rules and their footer text. Never: reads files (files.ts does) or decides what the agent needs.

/** Characters one files.read answer shows at most (well under the engines' own output cuts). */
export const WINDOW_CHARS = 32_000;
/** Bytes read from disk when the agent asks for lines further down (a bigger file is read up to here only). */
export const LINE_READ_BYTES = 8 * 1024 * 1024;

export interface WindowArgs { fromLine?: number; lines?: number }

/** `text` (the file's start up to the bytes read) cut to whole lines; `complete`: the whole file was read. */
export function lineWindow(text: string, args: WindowArgs, complete: boolean): string {
  const all = text.split(/\r?\n/);
  if (!complete && all.length > 1) all.pop(); // the last line may be cut by the byte limit
  const total = all.length;
  const from = Math.max(1, Math.floor(args.fromLine ?? 1));
  if (from > total) return `[The file has ${complete ? '' : 'at least '}${total} lines; nothing from line ${from} on.]`;
  const wanted = args.lines !== undefined ? Math.max(1, Math.floor(args.lines)) : Number.POSITIVE_INFINITY;
  const shown: string[] = [];
  let chars = 0;
  for (let i = from - 1; i < total && shown.length < wanted; i++) {
    const line = all[i];
    if (shown.length && chars + line.length + 1 > WINDOW_CHARS) break;
    shown.push(line.length > WINDOW_CHARS ? `${line.slice(0, WINDOW_CHARS)}… [line cut]` : line);
    chars += Math.min(line.length, WINDOW_CHARS) + 1;
  }
  const last = from + shown.length - 1;
  const body = shown.join('\n');
  if (from === 1 && last >= total && complete) return body; // a short file stays exactly as it is
  const of = complete ? `${total}` : `at least ${total}`;
  const more = last < total || !complete ? ` – continue with files.read fromLine: ${last + 1}, or find lines with files.search (content: true)` : '';
  return `${body}\n[Lines ${from}–${last} of ${of} shown${more}.]`;
}
