// The name in a page header as the object's dropdown: a click opens the same menu a right click on the object
// opens (menus.ts), under the name. Used by the agent page and a person's page.
// Owns: the title button and its menu. Never: decides the menu's items.

import { useState } from 'preact/hooks';
import { Icon, Menu } from '../lib/ui.tsx';
import type { MenuSection } from '../lib/ui.tsx';

export function TitleMenu(props: { name: string; sections: () => MenuSection[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button type="button" class="title-menu" aria-haspopup="menu" aria-expanded={anchor !== null} onClick={(event) => setAnchor(anchor ? null : event.currentTarget as HTMLElement)}>
        <span class="title-menu-text">{props.name}</span>
        <Icon name="caret-down" size={12} class="title-menu-caret" />
      </button>
      <Menu anchor={anchor} open={anchor !== null} onClose={() => setAnchor(null)} placement="bottom-start" label={`${props.name} menu`} sections={anchor ? props.sections() : []} />
    </>
  );
}
