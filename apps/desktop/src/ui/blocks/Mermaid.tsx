// ```mermaid diagrams in messages: rendered when scrolled near the viewport, from cache when
// possible; a failed render shows the source collapsed (no error to the agent).
// Owns: the diagram element. Never: renders while the fence is still streaming.

import { useEffect, useRef, useState } from 'preact/hooks';
import { cachedSvg, renderMermaid } from './mermaid.ts';
import { theme } from './host.ts';
import { SourceFallback } from './CodeBlock.tsx';

export function MermaidBlock(props: { source: string; closed: boolean }) {
  const current = theme.value;
  const [svg, setSvg] = useState<string | undefined>(() => cachedSvg(props.source, current));
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!props.closed) return;
    const hit = cachedSvg(props.source, current);
    if (hit) { setSvg(hit); return; }
    let cancelled = false;
    const el = ref.current;
    const start = () => {
      renderMermaid(props.source, current).then(
        out => { if (!cancelled) { setSvg(out); setFailed(false); } },
        () => { if (!cancelled) setFailed(true); },
      );
    };
    if (!el || typeof IntersectionObserver === 'undefined') { start(); return () => { cancelled = true; }; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); start(); }
    }, { rootMargin: '400px' });
    observer.observe(el);
    return () => { cancelled = true; observer.disconnect(); };
  }, [props.source, props.closed, current]);

  if (failed) return <SourceFallback label="Diagram couldn't be displayed" source={props.source} lang="mermaid" />;
  if (!svg) return <div ref={ref} class="block-skeleton" aria-busy="true">Preparing diagram…</div>;
  return <div class="mermaid-block" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
