// The page area under the address row: the native surface slot (native-surface.ts places main's view
// on it and hides it behind dialogs, popovers and toasts – no timer loop), the new-tab page on a blank
// tab (NewTabPage.tsx), and a failure lying over the page's lower edge (the native view is hidden while
// it shows), so nothing ever pushes the page.
// Owns: that area. Never: runs scripts in external pages or draws the header (BrowserHeader.tsx).

import { useRef } from 'preact/hooks';
import { bridge } from '../lib/platform.ts';
import { IconButton } from '../lib/ui.tsx';
import { useNativeSurface } from './native-surface.ts';
import { NewTabPage } from './NewTabPage.tsx';
import { browserPages, openError, pagesListed, tabsOf } from './pages.ts';
import { useSpace } from './space.ts';

export function BrowserPage(props: { id: string | undefined }) {
  const { id } = props;
  const native = bridge?.workspaceBrowser;
  const surface = useRef<HTMLDivElement>(null);
  const space = useSpace();
  const blank = !id || tabsOf(space).find((item) => item.id === id)?.kind !== 'website';
  const opened = openError.value;
  const failure = opened && opened.id === id ? opened.message : '';
  const problem = failure || browserPages.value.find((item) => item.id === id)?.error;
  useNativeSurface(surface, id ?? '', native, !blank && !problem);
  if (native && !pagesListed.value) return <div class="browser-body" />;
  return (
    <div class="browser-body">
      {blank
        ? <NewTabPage id={id ?? ''} />
        : <div class="browser-native-slot" ref={surface} aria-label="Website" />}
      {problem && (
        <p class="browser-error" role="alert">
          <span>{problem}</span>
          {failure && <IconButton icon="x" label="Dismiss" size="small" onClick={() => { openError.value = null; }} />}
        </p>
      )}
    </div>
  );
}
