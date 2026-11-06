// Code fences: monospace, no syntax highlighting (cheap), language label and a copy button.
// Also used as the collapsed "source" view for blocks that could not be displayed.
// Owns: code/source presentation. Never: executes or renders code as HTML.

import { useState } from 'preact/hooks';
import { IconButton } from '../lib/ui.tsx';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CodeBlock(props: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(props.code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div class="code-block">
      <div class="code-head">
        <span class="code-lang">{props.lang || ''}</span>
        <IconButton icon={copied ? 'check' : 'copy'} label={copied ? 'Copied' : 'Copy'} size="small" onClick={copy} />
      </div>
      <pre><code>{props.code}</code></pre>
    </div>
  );
}

/** A block that could not be displayed: one quiet line, source on demand. */
export function SourceFallback(props: { label: string; source: string; lang?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="block-fallback">
      <button type="button" class="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {props.label}
      </button>
      {open && <CodeBlock code={props.source} lang={props.lang} />}
    </div>
  );
}
