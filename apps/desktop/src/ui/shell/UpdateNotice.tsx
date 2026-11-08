// AF-019: the update notice – when main offers a newer version, a card in the corner says "Version X is available"
// with the release notes and two buttons: "Install now" (download, save the drafts, restart: main's apply(), the same
// way as the rail's update button) and "Later" (hides the card for this version and skips the automatic restart in
// this run: main's defer()). A later version shows the card again. Non-modal: it never blocks the window.
// Owns: the card and the remembered "Later" version. Never: checks or installs itself.

import { signal } from '@preact/signals';
import { bridge } from '../lib/platform.ts';
import { updateState } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { installLabel, showsNotice } from '../settings/updates-text.ts';

const KEY = 'autark.update.later';

function stored(): string | null {
  try { return globalThis.localStorage?.getItem(KEY) ?? null; } catch { return null; }
}

const later = signal<string | null>(stored());

function remember(version: string | undefined): void {
  later.value = version ?? null;
  try { if (version) globalThis.localStorage?.setItem(KEY, version); } catch { /* private window */ }
}

async function run(action: 'apply' | 'defer'): Promise<void> {
  try { await bridge?.updates?.[action](); } catch (error) { toastError(error, 'Update failed'); }
}

export function UpdateNotice() {
  const state = updateState.value;
  if (!bridge?.updates || !state || !showsNotice(state, later.value)) return null;
  const version = state.availableVersion;
  return (
    <section class="update-notice" role="dialog" aria-modal="false" aria-labelledby="update-notice-title" data-tour="update-notice">
      <p class="update-notice-title" id="update-notice-title">Version {version} is available</p>
      <p class="muted update-notice-source">
        You have {state.version}{state.source ? ` · from ${state.source}` : ''}
      </p>
      {state.releaseName && state.releaseName !== version && state.releaseName !== `v${version}` && <p class="update-notice-name">{state.releaseName}</p>}
      {state.releaseNotes
        ? <div class="update-notes" aria-label="Release notes">{state.releaseNotes}</div>
        : <p class="muted">No release notes for this version.</p>}
      <p class="muted update-notice-hint">{state.automaticInstall ? 'Your drafts are saved first; Autark restarts by itself.' : 'Opens the download page – install the new version by hand.'}</p>
      <div class="update-actions">
        <button type="button" class="button ghost" onClick={() => { remember(version); void run('defer'); }}>Later</button>
        <button type="button" class="button primary" onClick={() => { remember(version); void run('apply'); }}>{installLabel(state)}</button>
      </div>
    </section>
  );
}
