// Main's read-mostly view of the runtime's settings (the runtime owns them; main only reacts):
// theme → title bar colors, closeToTray, openAtLogin, autoDownloadUpdates, the profile name.
// Owns: the cached copy, defaults before the runtime answered, change notification.
// Never: persists settings itself (settings.update goes to the runtime) or imports electron.

import type { EventMap } from '../shared/api/events.ts';
import type { MethodName, ParamsOf, ResultOf } from '../shared/api/methods.ts';
import type { Topic } from '../shared/api/protocol.ts';
import type { Preferences, Settings, SettingsPatch } from '../shared/model/system.ts';

export type DesktopPreferences = Pick<Preferences, 'theme' | 'closeToTray' | 'openAtLogin' | 'autoDownloadUpdates'>;

/** Same defaults as the runtime (src/runtime/settings/defaults.ts). */
export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = {
  theme: 'system',
  closeToTray: true,
  openAtLogin: false,
  autoDownloadUpdates: false,
};

export interface SettingsRpc {
  call<M extends MethodName>(method: M, params?: ParamsOf<M>, timeoutMs?: number): Promise<ResultOf<M>>;
  on<E extends 'settings.updated'>(event: E, listener: (data: EventMap[E]) => void): () => void;
  subscribe(topic: Topic): Promise<() => void>;
}

export type SettingsListener = (next: Settings, previous: Settings | null) => void;

export class SettingsView {
  private readonly rpc: SettingsRpc;
  private readonly listeners = new Set<SettingsListener>();
  private value: Settings | null = null;
  private started = false;

  constructor(rpc: SettingsRpc) {
    this.rpc = rpc;
  }

  get current(): Settings | null { return this.value; }

  preferences(): DesktopPreferences {
    const prefs = this.value?.preferences;
    return {
      theme: prefs?.theme ?? DEFAULT_DESKTOP_PREFERENCES.theme,
      closeToTray: prefs?.closeToTray ?? DEFAULT_DESKTOP_PREFERENCES.closeToTray,
      openAtLogin: prefs?.openAtLogin ?? DEFAULT_DESKTOP_PREFERENCES.openAtLogin,
      autoDownloadUpdates: prefs?.autoDownloadUpdates ?? DEFAULT_DESKTOP_PREFERENCES.autoDownloadUpdates,
    };
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Subscribes once (the RpcClient restores the topic after reconnects), then loads. */
  async start(): Promise<void> {
    if (!this.started) {
      this.started = true;
      this.rpc.on('settings.updated', settings => this.set(settings));
      await this.rpc.subscribe('system');
    }
    await this.reload();
  }

  /** Re-reads after every runtime start (settings may have changed while it was down). */
  async reload(): Promise<void> {
    this.set(await this.rpc.call('settings.get'));
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const settings = await this.rpc.call('settings.update', patch);
    this.set(settings);
    return settings;
  }

  private set(next: Settings): void {
    if (!next || typeof next !== 'object' || !next.preferences) return;
    const previous = this.value;
    this.value = next;
    for (const listener of [...this.listeners]) {
      try { listener(next, previous); } catch { /* one bad listener must not hide the change from others */ }
    }
  }
}

/** Which desktop-relevant preferences differ (all of them on the first load). */
export function changedPreferences(next: Settings, previous: Settings | null): Array<keyof DesktopPreferences> {
  const keys: Array<keyof DesktopPreferences> = ['theme', 'closeToTray', 'openAtLogin', 'autoDownloadUpdates'];
  if (!previous) return keys;
  return keys.filter(key => next.preferences[key] !== previous.preferences[key]);
}
