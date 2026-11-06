// The bound of a native tool output (Codex command output and file diffs, Claude tool_result content, a code-mode
// script's printed text): head and tail kept.
// Owns: that bound. Never: invents content.

/** Bound of one native tool output (tool_end.output). */
export const OUTPUT_CAP = 64_000;

/** `text` at most `cap` characters: the head and the tail, the middle replaced by a marker. */
export function boundOutput(text: string, cap = OUTPUT_CAP): string {
  if (text.length <= cap) return text;
  const tail = Math.floor(cap / 4);
  const head = cap - tail - 40;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters cut …]\n${text.slice(-tail)}`;
}
