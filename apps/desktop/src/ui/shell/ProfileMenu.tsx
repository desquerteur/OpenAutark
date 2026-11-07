// Profile bubble (bottom of the rail) and its menu: name/company, the companies on this PC (B-072, desktop window only:
// one picked opens its window and this one goes to the tray, its agents keep working) and Settings. B-078: a "+" beside
// the company name opens the add menu in the same place – New company / Connect as my other device / Join a company as
// employee; each starts a new company whose first run opens that way (companies.open start). In the phone layout, where
// the rail with its quota badges is hidden, the menu shows the same badges (QuotaRail). Inside the Android app the menu
// also holds "Forget this phone" (pwa/native.ts – the app asks before it clears its pairing; it has no toolbar of its own).
// Owns: the bubble and menu. Never: edits the profile itself (the AI or Settings does), opens a company itself (main
// does, through companies.open).

import { useEffect, useRef, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import type { CompanyEntry, CompanyStart } from '../../shared/model/companies.ts';
import { HumanAvatar, IconButton, Menu } from '../lib/ui.tsx';
import type { MenuItem, MenuSection } from '../lib/ui.tsx';
import { isMobile, settings } from '../lib/store.ts';
import { go } from '../lib/router.ts';
import { comboLabel } from '../lib/hotkeys.ts';
import { platform } from '../lib/platform.ts';
import { rpc } from '../lib/rpc.ts';
import { toastError } from '../lib/toasts.ts';
import { openFeedback } from '../feedback/popover-state.ts';
import { forgetThisPhone, isPhoneApp } from '../pwa/native.ts';
import { QuotaRail } from './QuotaRail.tsx';

/** The command palette's Feedback: the header cell's menu (after its screenshot). */
export { openFeedback };

const ITEMS: MenuItem[] = [
  { label: 'Settings', hint: comboLabel('mod+,'), onSelect: () => go.settings() },
  ...(isPhoneApp() ? [{ label: 'Forget this phone', description: 'Signs this phone out here; remove it on the PC too', onSelect: forgetThisPhone }] : []),
];

/** The companies on this PC, kept between openings: the menu opens at its full height, nothing grows under the pointer. */
const companies = signal<CompanyEntry[]>([]);

function loadCompanies(): void {
  if (platform !== 'desktop') return; // a phone or browser belongs to the company it is paired with
  rpc.call('companies.list').then((result) => { companies.value = result.companies; }, () => { /* the last list stays */ });
}

function openCompany(params: { id: string | null } | { create: true; start: CompanyStart }): void {
  rpc.call('companies.open', params).catch((error: unknown) => toastError(error, 'Could not open the company'));
}

/** The company menu's "+" (B-078): each one starts a new company folder; its first run opens that way (`--start=`). */
const ADD_ITEMS: MenuItem[] = [
  { label: 'New company', description: 'Your own, with its own first run', onSelect: () => openCompany({ create: true, start: 'new' }) },
  { label: 'Connect as my other device', description: 'The same company as on another PC – everything mirrored', onSelect: () => openCompany({ create: true, start: 'mine' }) },
  { label: 'Join a company as employee', description: 'Someone else\'s company, as one person there', onSelect: () => openCompany({ create: true, start: 'employee' }) },
];

/** The companies (the current one ticked); none where there is no list (a test profile, the PWA). */
function companySections(list: CompanyEntry[]): MenuSection[] {
  if (!list.length) return [];
  return [{ items: list.map((company) => ({
    label: company.label,
    checked: company.current,
    onSelect: () => { if (!company.current) openCompany({ id: company.id }); },
  })) }];
}

export function ProfileButton(props: { size?: number; placement?: 'right-end' | 'bottom-end' }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const profile = settings.value?.profile;
  const name = profile?.name || 'Profile';
  const canAdd = companies.value.length > 0;
  useEffect(loadCompanies, []);
  return (
    <>
      <button ref={ref} type="button" class="profile-button" data-tour="settings" aria-label="Profile menu" aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) loadCompanies(); setOpen(!open); }}>
        <HumanAvatar size={props.size ?? 36} />
      </button>
      <Menu
        anchor={ref.current}
        open={open}
        onClose={() => setOpen(false)}
        placement={props.placement ?? 'right-end'}
        width={256}
        class="profile-menu"
        label="Profile"
        header={
          <>
            <div class="profile-head-row">
              <button type="button" class="profile-head" onClick={() => { setOpen(false); go.settings(); }}>
                <span class="profile-name">{name}</span>
                {profile?.company && <span class="profile-company">{profile.company}</span>}
              </button>
              {canAdd && <IconButton icon="plus" label="Add a company" class="profile-add" onClick={() => { setOpen(false); setAdding(true); }} />}
            </div>
            {isMobile.value && <div class="profile-quota"><QuotaRail /></div>}
          </>
        }
        sections={[...companySections(companies.value), { items: ITEMS }]}
      />
      <Menu anchor={ref.current} open={adding} onClose={() => setAdding(false)} placement={props.placement ?? 'right-end'} width={280} class="profile-menu" label="Add a company" sections={[{ items: ADD_ITEMS }]} />
    </>
  );
}
