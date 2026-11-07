// Settings navigation in the shell's single sidebar while Settings is open (and the phone's settings list): its header
// data (settingsNavHeader – "Settings" with the in-place search, drawn by the frame's header row, shell/views.ts) and the
// pages this connection may use (sections.ts). The search matches page titles and every row keyword; Enter opens the
// first match.
// Owns: the page list and the search text. Never: renders page content or header markup.

import { signal } from '@preact/signals';
import { Icon } from '../lib/icons.tsx';
import type { HeaderProps } from '../lib/header.tsx';
import { isMobile } from '../lib/platform.ts';
import { navigate, route } from '../lib/router.ts';
import { can } from '../lib/session.ts';
import { resolveVisibleSection, searchSections, visibleSections } from './sections.ts';

/** Shared with Settings.tsx so the content can highlight matching rows. */
export const settingsSearch = signal('');
/** The search field is open (it stays open while it holds text). */
const searchOpen = signal(false);

/** The Settings header: "Settings" and the magnifier, whose field takes the title's place. */
export function settingsNavHeader(): HeaderProps {
  const query = settingsSearch.value;
  return {
    title: 'Settings',
    search: {
      label: 'Search settings', placeholder: 'Search settings', open: searchOpen.value || query !== '', query,
      onQuery: (text) => { settingsSearch.value = text; },
      onOpenChange: (open) => { searchOpen.value = open; },
      onSubmit: (text) => {
        const first = searchSections(text, visibleSections(can))[0];
        if (first) navigate({ view: 'settings', section: first.id });
      },
    },
  };
}

/** AF-002: the spotlight tour's names of Settings pages (tour/spotlight-steps.ts); every row also carries data-page. */
const NAV_TOUR: Partial<Record<string, string>> = { models: 'accounts', skills: 'skills' };

export function SettingsNav() {
  // The phone's list shows only while no page is open: nothing is highlighted there.
  const current = route.value.view === 'settings' && !isMobile.value ? resolveVisibleSection(route.value.section, can).id : null;
  const matches = searchSections(settingsSearch.value, visibleSections(can));
  return (
    <nav class="settings-nav" aria-label="Settings pages">
      <ul class="settings-nav-list">
        {matches.map((section) => (
          <li key={section.id}>
            <button type="button" class={`settings-nav-item${section.id === current ? ' selected' : ''}`} aria-current={section.id === current ? 'page' : undefined} data-page={section.id} data-tour={NAV_TOUR[section.id]}
              onClick={() => navigate({ view: 'settings', section: section.id }, { replace: route.value.view === 'settings' })}>
              <Icon name={section.icon} size={18} />
              <span>{section.title}</span>
            </button>
          </li>
        ))}
        {!matches.length && <li class="settings-nav-empty">No matching settings</li>}
      </ul>
    </nav>
  );
}
