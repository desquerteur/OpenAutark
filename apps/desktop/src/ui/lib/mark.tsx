// Search highlighting: a text with every occurrence of the query's words (2+ characters, any case)
// wrapped in <mark class="search-mark"> – the palette's labels and the chat list's message hits.
// Colour only (base.css), so a highlighted text has the same width as a plain one.
// Owns: splitting a text into marked parts. Never: decides what matches a search (the callers do).

import type { ComponentChildren } from 'preact';
import { markRanges } from './mark-ranges.ts';

export function Marked(props: { text: string; query: string }) {
  const { text } = props;
  const ranges = markRanges(text, props.query);
  if (!ranges.length) return <>{text}</>;
  const parts: ComponentChildren[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={start} class="search-mark">{text.slice(start, end)}</mark>);
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
