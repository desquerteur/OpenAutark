// A file's text cut into chunks for embedding: it breaks at headings and blank lines where it can, about CHUNK_CHARS
// long (~500 tokens; CJK characters count as more), with the last lines repeated at the start of the next chunk.
// Deterministic: the same text gives the same chunks, so an interrupted file can continue at its next chunk.
// Owns: where a text is cut. Never: reads files or embeds.

export const CHUNK_CHARS = 1800;
const OVERLAP_CHARS = 200;
/** Below this a chunk does not end at a heading or blank line yet. */
const MIN_CHARS = 500;

export interface TextChunk {
  text: string;
  /** First and last line, from 1. */
  from: number;
  to: number;
}

const WIDE = /[぀-ヿ㐀-鿿가-힯]/g;
const weight = (line: string): number => line.length + (line.match(WIDE)?.length ?? 0) * 3 + 1;

/** One line longer than a chunk (minified code, a CSV row) is cut into pieces that keep its line number. */
function pieces(lines: string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  lines.forEach((text, index) => {
    if (weight(text) <= CHUNK_CHARS) { out.push({ text, line: index + 1 }); return; }
    const step = Math.max(200, Math.floor(CHUNK_CHARS * (text.length / weight(text))));
    for (let at = 0; at < text.length; at += step) out.push({ text: text.slice(at, at + step), line: index + 1 });
  });
  return out;
}

export function chunkText(text: string): TextChunk[] {
  const parts = pieces(text.replace(/\r\n?/g, '\n').split('\n'));
  const chunks: TextChunk[] = [];
  let open: typeof parts = [];
  let size = 0;
  const close = () => {
    const body = open.map((part) => part.text).join('\n').trim();
    if (body) chunks.push({ text: body, from: open[0].line, to: open[open.length - 1].line });
    const kept: typeof parts = [];
    let keptSize = 0;
    for (let i = open.length - 1; i >= 0 && keptSize + weight(open[i].text) <= OVERLAP_CHARS; i--) {
      kept.unshift(open[i]);
      keptSize += weight(open[i].text);
    }
    open = kept;
    size = keptSize;
  };
  let fresh = 0; // lines since the last close: overlap alone is no chunk
  for (const part of parts) {
    const heading = /^#{1,6}\s/.test(part.text);
    const blank = !part.text.trim();
    if (fresh > 0 && (size + weight(part.text) > CHUNK_CHARS || ((heading || blank) && size >= MIN_CHARS))) { close(); fresh = 0; }
    open.push(part);
    size += weight(part.text);
    if (!blank) fresh++;
  }
  if (fresh > 0) close();
  return chunks;
}
