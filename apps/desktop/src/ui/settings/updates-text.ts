// AF-019: what Settings › Updates and the update notice say for main's UpdateState – the status line, the source
// choices (this build's fork, the upstream teydra/OpenAutark or another repository) and when the notice shows.
// The two repository names are the same as src/main/updates/release.ts (a unit test keeps them equal).
// Owns: these texts and rules. Pure: no DOM, no bridge.

import type { UpdateState } from '../../shared/model/system.ts';
import { installingText } from '../shell/update-control.ts';

export const FORK_REPOSITORY = 'desquerteur/OpenAutark';
export const UPSTREAM_REPOSITORY = 'teydra/OpenAutark';

export type SourceChoice = 'fork' | 'upstream' | 'custom';

export const SOURCE_OPTIONS: Array<{ value: SourceChoice; label: string; hint: string }> = [
  { value: 'fork', label: FORK_REPOSITORY, hint: 'Your own fork – the default of this build' },
  { value: 'upstream', label: UPSTREAM_REPOSITORY, hint: 'The original project – its updates replace your own changes' },
  { value: 'custom', label: 'Another repository…', hint: 'Any GitHub repository with Autark releases (owner/name)' },
];

export function sourceChoice(repository: string | undefined): SourceChoice {
  const name = (repository ?? FORK_REPOSITORY).toLowerCase();
  if (name === FORK_REPOSITORY.toLowerCase()) return 'fork';
  if (name === UPSTREAM_REPOSITORY.toLowerCase()) return 'upstream';
  return 'custom';
}

export function repositoryOf(choice: SourceChoice): string | null {
  if (choice === 'fork') return FORK_REPOSITORY;
  if (choice === 'upstream') return UPSTREAM_REPOSITORY;
  return null;
}

/** The status line under the version (Settings › Updates and About). */
export function updateStatusText(state: UpdateState | null, platform?: string): string {
  if (!state) return 'Unavailable';
  switch (state.status) {
    case 'development': return 'Development build – only an installed version updates itself';
    case 'idle': return state.autoCheck === false ? 'Automatic checks are off' : 'Not checked yet';
    case 'checking': return `Checking ${state.source ?? 'for updates'}…`;
    case 'available': return `Version ${state.availableVersion ?? ''} available`;
    case 'downloading': return `Downloading ${Math.round(state.percent)}%`;
    case 'downloaded': return `Version ${state.availableVersion ?? ''} ready`;
    case 'installing': return installingText(state, platform);
    case 'error': return state.message ?? 'Update failed';
    default: return state.message ?? 'Up to date';
  }
}

/** "Check for updates now" can run (not while one runs, downloads or installs; never in a development build). */
export function canCheckNow(state: UpdateState | null): boolean {
  return !!state && !['development', 'checking', 'downloading', 'downloaded', 'installing'].includes(state.status);
}

/** The notice "Version X is available" shows for an offered version the person has not put off with "Later". */
export function showsNotice(state: UpdateState | null, dismissed: string | null): boolean {
  return state?.status === 'available' && !!state.availableVersion && state.availableVersion !== dismissed;
}

/** The notice's main button: the app installs by itself (download → save drafts → restart) or opens the download. */
export function installLabel(state: Pick<UpdateState, 'automaticInstall'>): string {
  return state.automaticInstall ? 'Install now' : 'Download';
}
