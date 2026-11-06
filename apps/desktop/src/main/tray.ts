// Tray icon: keeps the app reachable while the window is closed (agents keep working).
// Menu: Open, Quit – and while the runtime is up "Stop all agent work" (with its shortcut while that is
// registered), after it "Resume agent work" (the emergency stop, main/work-stop.ts). Tooltip: product
// name plus the open count from the runtime badge and the emergency-stop line.
// Owns: the Tray object and its icon representations. Never: business state, imports electron
// at runtime (index.ts passes Tray/Menu/nativeImage in).

import type { Menu, MenuItemConstructorOptions, NativeImage, Tray } from 'electron';
import { WORK_STOP_KEYS } from '../shared/model/work-stop.ts';
import type { TrayWorkStop } from './work-stop.ts';

export interface TrayElectron {
  Tray: new (image: NativeImage) => Tray;
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu };
  nativeImage: { createFromPath(file: string): NativeImage; createEmpty(): NativeImage };
}

export interface AppTrayDeps {
  electron: TrayElectron;
  iconPath: string;
  name: string;
  platform: string;
  onOpen(): void;
  onQuit(): void;
  onStopWork?(): void;
  onResumeWork?(): void;
}

export function trayTooltip(name: string, count: number, work: TrayWorkStop = null): string {
  const base = count > 0 ? `${name} (${count > 999 ? '999+' : count})` : name;
  // Windows cuts tray tooltips at 127 characters.
  return [base, work?.kind === 'stopped' ? 'Agent work stopped' : ''].filter(Boolean).join(' – ').slice(0, 127);
}

/** The tray menu: Open, the emergency stop (or its Resume), Quit. */
export function trayMenu(deps: Pick<AppTrayDeps, 'onOpen' | 'onQuit' | 'onStopWork' | 'onResumeWork'>, work: TrayWorkStop = null): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [{ label: 'Open', click: () => deps.onOpen() }];
  if (work?.kind === 'ready' && deps.onStopWork) items.push({ label: 'Stop all agent work', ...(work.shortcut ? { accelerator: WORK_STOP_KEYS, registerAccelerator: false } : {}), click: () => deps.onStopWork?.() });
  if (work?.kind === 'stopped' && deps.onResumeWork) items.push({ label: 'Resume agent work', click: () => deps.onResumeWork?.() });
  items.push({ type: 'separator' }, { label: 'Quit', click: () => deps.onQuit() });
  return items;
}

/** Small icon with 1×/1.5×/2× representations so the tray stays sharp on scaled displays. */
function trayIcon(electron: TrayElectron, iconPath: string, platform: string): NativeImage {
  const source = electron.nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) return source;
  const base = platform === 'linux' ? 22 : 16;
  const image = electron.nativeImage.createEmpty();
  for (const scaleFactor of [1, 1.5, 2]) {
    const size = Math.round(base * scaleFactor);
    const resized = source.resize({ width: size, height: size, quality: 'best' });
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: resized.toPNG() });
  }
  return image;
}

export class AppTray {
  private readonly deps: AppTrayDeps;
  private tray: Tray | null = null;
  private count = 0;
  private work: TrayWorkStop = null;

  constructor(deps: AppTrayDeps) {
    this.deps = deps;
  }

  create(): void {
    if (this.tray) return;
    const { electron } = this.deps;
    const tray = new electron.Tray(trayIcon(electron, this.deps.iconPath, this.deps.platform));
    tray.setToolTip(trayTooltip(this.deps.name, this.count, this.work));
    tray.setContextMenu(electron.Menu.buildFromTemplate(trayMenu(this.deps, this.work)));
    // Windows/Linux: a left click opens the window (macOS shows the menu on click).
    if (this.deps.platform !== 'darwin') tray.on('click', () => this.deps.onOpen());
    this.tray = tray;
  }

  setBadge(count: number): void {
    this.count = count;
    try { this.tray?.setToolTip(trayTooltip(this.deps.name, count, this.work)); } catch { /* destroyed */ }
  }

  /** The emergency stop changed (main/work-stop.ts): menu entry and tooltip line. */
  setWorkStop(view: TrayWorkStop): void {
    const same = JSON.stringify(view) === JSON.stringify(this.work);
    this.work = view;
    if (!same) this.refresh();
  }

  private refresh(): void {
    if (!this.tray) return;
    try {
      this.tray.setToolTip(trayTooltip(this.deps.name, this.count, this.work));
      this.tray.setContextMenu(this.deps.electron.Menu.buildFromTemplate(trayMenu(this.deps, this.work)));
    } catch { /* destroyed */ }
  }

  destroy(): void {
    try { this.tray?.destroy(); } catch { /* already gone */ }
    this.tray = null;
  }
}
