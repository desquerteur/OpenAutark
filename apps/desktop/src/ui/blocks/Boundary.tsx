// Error boundary for untrusted or evolving content (agent blocks, settings sections, panes):
// a render error in one part shows a quiet fallback instead of blanking the whole window.
// Owns: catching render errors below it and the reset. Never: reports errors anywhere
// (console only) or retries by itself.

import type { ComponentChildren } from 'preact';
import { useErrorBoundary } from 'preact/hooks';

export function Boundary(props: { children: ComponentChildren; fallback?: (reset: () => void) => ComponentChildren }) {
  const [error, reset] = useErrorBoundary((caught: unknown) => console.error('[ui] render failed', caught));
  if (error) {
    return props.fallback
      ? <>{props.fallback(reset)}</>
      : (
        <div class="boundary-error" role="status">
          <span>Couldn't display this part.</span>
          <button type="button" class="text-button" onClick={reset}>Retry</button>
        </div>
      );
  }
  return <>{props.children}</>;
}
