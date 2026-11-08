// The body of one message: Markdown with live ```mermaid, ```ui and ```app fences
// (web-genui §7). Parsing is memoized by body (final messages share a small cache); while a
// message streams, every part except the tail keeps its identity, so only the tail re-renders.
// A later agent or system block with the same `id` in the chat supersedes an earlier one ("Updated below").
// The person's answer line to an ask block (kind 'answer') keeps its line breaks.
// Owns: part → renderer mapping, skeletons and "Couldn't display" fallbacks.
// Never: renders raw HTML (markdown.tsx sanitizes), makes agent blocks binding, runs ```app
// fences written by anyone but an agent, or shows ask widgets from humans/external bridges.

import { memo } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import { specFor } from '../../shared/blocks/catalog.ts';
import type { UiBlock } from '../../shared/blocks/catalog.ts';
import { parseMessage, repairStreamingTail } from '../../shared/blocks/parse.ts';
import type { Part } from '../../shared/blocks/parse.ts';
import type { Message } from '../../shared/model/chat.ts';
import { AppFrame } from './AppFrame.tsx';
import { AskBlock } from './AskBlock.tsx';
import { Boundary } from './Boundary.tsx';
import { CodeBlock, SourceFallback } from './CodeBlock.tsx';
import { hash } from './host.ts';
import { isSuperseded, registerMessageIds } from './ids.ts';
import { Markdown } from './markdown.tsx';
import { MermaidBlock } from './Mermaid.tsx';
import { DisplayBlock } from './registry.tsx';
import { agentLinker } from '../agents/agent-link-state.ts'; // AF-017: agent names become links

// ------------------------------------------------------------------ parsing + memo

const finalCache = new Map<string, { body: string; parts: Part[] }>();
const CACHE_MAX = 300;

function parseFinal(body: string): Part[] {
  const key = `${body.length}:${hash(body)}`;
  const hit = finalCache.get(key);
  if (hit && hit.body === body) return hit.parts;
  const parts = parseMessage(body);
  if (finalCache.size >= CACHE_MAX) finalCache.delete(finalCache.keys().next().value as string);
  finalCache.set(key, { body, parts });
  return parts;
}

/** True when a part from the previous parse can be reused (same position, same content). */
function samePart(a: Part, b: Part): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'markdown': return a.text === (b as typeof a).text;
    case 'code': return a.text === (b as typeof a).text && a.closed === (b as typeof a).closed && a.lang === (b as typeof a).lang;
    case 'mermaid': return a.source === (b as typeof a).source && a.closed === (b as typeof a).closed;
    case 'ui': return a.index === (b as typeof a).index && a.result.ok === (b as typeof a).result.ok;
    case 'app': return a.index === (b as typeof a).index && a.closed === (b as typeof a).closed && a.html === (b as typeof a).html;
    default: return false;
  }
}

/** The person's answer line (kind 'answer', B-076: "Label: value" lines of a form, a note) keeps its line breaks. */
const bodyOf = (message: Message): string => (message.kind === 'answer' ? message.body.replace(/\n/g, '  \n') : message.body);

function useParts(message: Message): Part[] {
  const memo = useRef<{ body: string; streaming: boolean; parts: Part[] } | null>(null);
  const streaming = message.state === 'streaming';
  const body = bodyOf(message);
  const prev = memo.current;
  if (prev && prev.body === body && prev.streaming === streaming) return prev.parts;
  let parts: Part[];
  if (!streaming) parts = parseFinal(body);
  else {
    parts = parseMessage(body, { streaming: true });
    const last = parts[parts.length - 1];
    if (last?.kind === 'markdown') parts[parts.length - 1] = { kind: 'markdown', text: repairStreamingTail(last.text) };
    // Everything before the previous tail is final: keep those objects so memoized parts skip.
    if (prev) {
      const stable = Math.min(prev.parts.length - 1, parts.length - 1);
      for (let i = 0; i < stable; i++) if (samePart(prev.parts[i], parts[i])) parts[i] = prev.parts[i];
    }
  }
  memo.current = { body, streaming, parts };
  return parts;
}

// ------------------------------------------------------------------ part views

const SKELETON: Record<string, string> = {
  chart: 'chart', table: 'table', steps: 'steps', stats: 'numbers', timeline: 'timeline', compare: 'comparison', cards: 'cards',
  media: 'media', file: 'file', progress: 'progress', tabs: 'tabs', callout: 'note', record: 'recorder', form: 'form',
  approve: 'approval', choice: 'choice', checklist: 'checklist', timer: 'timer', upload: 'upload', confirm: 'step', review: 'review',
};

function Skeleton(props: { label: string }) {
  return <div class="block-skeleton" aria-busy="true">Preparing {props.label}…</div>;
}

/** Earlier version of a block that a later message replaced: one quiet line, history on demand. */
function Superseded(props: { block: UiBlock; ask: boolean; message: Message; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="block-updated">
      <button type="button" class="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>Updated below</button>
      {open && (props.ask
        ? <AskBlock block={props.block} target={{ kind: 'block', messageId: props.message.id, blockIndex: props.index }} />
        : <DisplayBlock block={props.block} />)}
    </div>
  );
}

function UiPart(props: { part: Extract<Part, { kind: 'ui' }>; message: Message }) {
  const { part, message } = props;
  const result = part.result;
  if (!result.ok) return <SourceFallback label="Couldn't display" source={result.source} lang="ui" />;
  const block = result.block;
  const ask = specFor(block.type)?.kind === 'ask';
  // Humans and external bridges cannot create to-dos for the human by writing a fence.
  if (ask && message.authorKind !== 'agent' && message.authorKind !== 'system') return <CodeBlock code={JSON.stringify(block, null, 2)} lang="ui" />;
  if (isSuperseded(message.conversationId, block.id, message.seq, part.index)) {
    return <Superseded block={block} ask={ask} message={message} index={part.index} />;
  }
  if (ask) return <AskBlock block={block} target={{ kind: 'block', messageId: message.id, blockIndex: part.index }} />;
  return <DisplayBlock block={block} />;
}

function AppPart(props: { part: Extract<Part, { kind: 'app' }>; message: Message }) {
  const { part, message } = props;
  if (message.authorKind !== 'agent') return <CodeBlock code={part.html} lang="app" />;
  if (part.index < 0 || message.state === 'streaming') return <Skeleton label={part.attrs.title ?? 'app'} />;
  if (part.error) {
    return part.html
      ? <SourceFallback label="Couldn't display" source={part.html} lang="app" />
      : <div class="block-fallback"><span class="muted">Couldn't display</span></div>;
  }
  return <AppFrame messageId={message.id} index={part.index} attrs={part.attrs} />;
}

function PartViewInner(props: { part: Part; message: Message }) {
  const { part, message } = props;
  let view;
  switch (part.kind) {
    case 'markdown': view = <Markdown text={agentLinker.value(part.text)} />; break; // AF-017
    case 'code': view = <CodeBlock code={part.text} lang={part.lang} />; break;
    case 'mermaid': view = <MermaidBlock source={part.source} closed={part.closed} />; break;
    case 'ui': view = <UiPart part={part} message={message} />; break;
    case 'ui-pending': view = <Skeleton label={(part.hint && SKELETON[part.hint]) || 'block'} />; break;
    case 'app': view = <AppPart part={part} message={message} />; break;
    default: return null;
  }
  return <Boundary>{view}</Boundary>;
}

/** Re-renders only when its own part object (or the message identity/state) changes. */
const PartView = memo(PartViewInner, (a, b) => a.part === b.part
  && a.message.id === b.message.id && a.message.state === b.message.state
  && a.message.seq === b.message.seq && a.message.authorKind === b.message.authorKind);

// ------------------------------------------------------------------ the body

export function MessageBody(props: { message: Message }) {
  const { message } = props;
  const parts = useParts(message);

  // Feed the per-chat "same id ⇒ update in place" registry once the blocks are final (agents
  // and the system only: an external author never collapses an agent's ask or approval block).
  const ids: Array<{ id: string; index: number }> = [];
  for (const part of parts) {
    if (part.kind === 'ui' && part.result.ok && typeof part.result.block.id === 'string' && part.result.block.id) {
      ids.push({ id: part.result.block.id, index: part.index });
    }
  }
  const idsKey = ids.map((entry) => `${entry.id}@${entry.index}`).join('|');
  useEffect(() => {
    if (ids.length) registerMessageIds(message, ids);
  }, [message.conversationId, message.seq, message.authorKind, idsKey]);

  return (
    <div class="message-body">
      {parts.map((part, i) => <PartView key={i} part={part} message={message} />)}
    </div>
  );
}
