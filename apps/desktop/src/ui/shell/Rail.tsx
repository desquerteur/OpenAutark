// Left rail: global destinations in the order of the phone tabs (My day – the person's own day, also
// the 'home' route, with the For-you badge – · Work – the task center – · Chats · Team) and, from the
// bottom up, Profile → weekly quotas → Update (only when relevant).
// Owns: rail layout and destination highlighting. Never: sidebar content.

import { IconButton } from '../lib/ui.tsx';
import type { IconName } from '../lib/ui.tsx';
import { forYouCount, route } from '../lib/store.ts';
import { navigate } from '../lib/router.ts';
import type { RouteView } from '../lib/router.ts';
import { DESTINATIONS } from '../lib/vocab.ts';
import type { NavKey } from '../lib/vocab.ts';
import { openChats } from './navigation.ts';
import { UpdateButton } from './UpdateButton.tsx';
import { QuotaRail } from './QuotaRail.tsx';
import { ProfileButton } from './ProfileMenu.tsx';
import { SidebarToggle } from './WindowBar.tsx';

interface Destination {
  key: NavKey;
  icon: IconName;
  views: RouteView[];
  open: () => void;
}

const destinations: Destination[] = [
  { key: 'day', icon: 'sun', views: ['home', 'day'], open: () => navigate({ view: 'day' }) },
  { key: 'tasks', icon: 'list-checks', views: ['tasks'], open: () => navigate({ view: 'tasks' }) },
  { key: 'chats', icon: 'chat-circle', views: ['chats', 'chat'], open: openChats },
  { key: 'team', icon: 'users-three', views: ['team'], open: () => navigate({ view: 'team' }) },
];

export function Rail() {
  const view = route.value.view;
  const badge = forYouCount.value;
  return (
    <nav class="rail" aria-label="Main">
      <div class="rail-header"><SidebarToggle /></div>
      <div class="rail-top">
        {destinations.map((destination) => (
          <div class="rail-item" key={destination.key}>
            <IconButton
              icon={destination.icon}
              label={DESTINATIONS[destination.key]}
              pressed={destination.views.includes(view)}
              aria-current={destination.views.includes(view) ? 'page' : undefined}
              onClick={destination.open}
            />
            {destination.key === 'day' && badge > 0 && <span class="rail-badge tabular" aria-label={`${badge} in ${DESTINATIONS.day}`}>{badge > 99 ? '99+' : badge}</span>}
          </div>
        ))}
      </div>
      <div class="rail-bottom">
        <UpdateButton />
        <QuotaRail />
        <ProfileButton />
      </div>
    </nav>
  );
}
