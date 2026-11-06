// The tabs a surface shows now – the tabs of its space (pages.ts tabsOf) – as the strip and the tab list draw them.
// Owns: that list. Never: which tabs exist (pages.ts) or how they look (TabStrip.tsx, TabsMenu.tsx).

import { appTitle } from './app-title.ts';
import { tabInfos, type TabInfo } from './browser-model.ts';
import { browserPages, tabsOf } from './pages.ts';

/** Read in a render, it follows the space's tabs and main's pages. */
export const tabInfosOf = (space: string): TabInfo[] => tabInfos(tabsOf(space), browserPages.value, appTitle);
