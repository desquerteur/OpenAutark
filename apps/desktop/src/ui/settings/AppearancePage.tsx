// Settings › Appearance (AF-008, data-tour="appearance"): the whole look and layout without editing a file.
// - Theme: the colour scheme (System, Light, Dark – preferences.theme) and the themes – Autark's own, the person's own
//   (appearance.themes) and ready-made starting points. "New theme", Edit or Duplicate open the editor: name, accent
//   colour, the content's background for the light and the dark scheme (with their contrast to the text), font and text
//   size, density and corner radius. Every change shows at once in the whole window and in the preview (both schemes)
//   – a draft until Save; Cancel puts the saved look back. A theme exports as a small file and imports from one.
// - Layout: the window in small (the sidebar, the chat, its tabs and the browser pane): the chat's tabs drag to a side
//   of the chat, its top or bottom or into it (floating); a click on the sidebar or the pane shows or hides it; the
//   sliders size each part. The panels a new tab offers (My day, Work, Notes, Media, Files, Agents) drag into an order
//   and hide or show. Everything is saved in settings.json at once and stays after a restart.
// - "Reset to default": Autark's own look and layout (the person's themes stay in the list).
// Owns: this page. Never: the theme's CSS (shared/model/themes.ts) or how it is applied (lib/theme.ts, lib/appearance.ts).

import { useRef, useState } from 'preact/hooks';
import { DOCK_LABELS, DOCK_PLACES, PANEL_LABELS, dockPlaceAt, type DockPlace, type PanelKind } from '../../shared/model/appearance.ts';
import {
  AUTARK_LOOK, DENSITIES, SCHEME_TEXT, THEME_LIMITS, THEME_PRESETS, contrastRatio, exportTheme, importTheme, themeCss, themeFileName, themeIdFor,
  type CustomTheme, type Density,
} from '../../shared/model/themes.ts';
import type { Preferences } from '../../shared/model/system.ts';
import {
  activeThemeId, chatDock, dockAt, hiddenPanels, panelOrder, resetAppearance, saveDock, savePanels, saveThemes, themeDraft, themes, chooseTheme,
} from '../lib/appearance.ts';
import { confirm } from '../lib/dialog.tsx';
import { openContextMenu } from '../lib/context-menu.tsx';
import { preferences, updatePreferences } from '../lib/store.ts';
import { pushToast, toastError } from '../lib/toasts.ts';
import { Icon, IconButton } from '../lib/ui.tsx';
import { act, ActionButton, Group, Row, Segmented, Toggle } from './controls.tsx';

const SCHEMES = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }] as const;
const DENSITY_LABELS: Record<Density, string> = { compact: 'Compact', regular: 'Regular', comfortable: 'Roomy' };
const FONT_SUGGESTIONS = ['Segoe UI', 'Arial', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Cambria', 'Consolas', 'Cascadia Code', 'Helvetica Neue', 'Avenir Next'];
const AUTARK_CARD = { id: '', name: 'Autark', ...AUTARK_LOOK };
const PLACE_OPTIONS = DOCK_PLACES.map((place) => ({ value: place, label: { right: 'Right', left: 'Left', bottom: 'Bottom', top: 'Top', float: 'Floating' }[place] }));

const setPrefs = (patch: Partial<Preferences>) => act(() => updatePreferences(patch), 'Could not save');

/** A theme's small picture: sidebar, content, two text lines and the accent. */
function Swatch(props: { theme: Omit<CustomTheme, 'id' | 'name'>; dark: boolean }) {
  const { theme, dark } = props;
  const bg = (dark ? theme.backgroundDark : theme.background) || (dark ? '#2b2b2b' : '#ffffff');
  const style = {
    '--sw-side': dark ? '#232323' : '#f5f5f5', '--sw-bg': bg, '--sw-text': dark ? SCHEME_TEXT.dark : SCHEME_TEXT.light,
    '--sw-accent': theme.accent || (dark ? SCHEME_TEXT.dark : SCHEME_TEXT.light), borderRadius: `${Math.round(theme.radius * 1.2)}px`,
  };
  return <span class="theme-swatch" style={style} aria-hidden="true"><i /><i /><em /><em /><b /></span>;
}

function useDark(): boolean {
  const scheme = preferences.value.theme;
  return scheme === 'dark' || (scheme === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
}

function ThemeCards(props: { onEdit(theme: CustomTheme, isNew: boolean): void }) {
  const dark = useDark();
  const list = themes.value;
  const active = activeThemeId.value;
  const fileInput = useRef<HTMLInputElement>(null);
  const cardMenu = (theme: CustomTheme, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    openContextMenu(rect.right, rect.bottom + 4, [{ items: [
      { label: 'Edit', onSelect: () => props.onEdit(theme, false) },
      { label: 'Duplicate', onSelect: () => props.onEdit({ ...theme, id: themeIdFor(`${theme.name} copy`, list.map((item) => item.id)), name: `${theme.name} copy`.slice(0, THEME_LIMITS.name) }, true) },
      { label: 'Export…', onSelect: () => downloadTheme(theme) },
      { label: 'Delete', danger: true, onSelect: () => void deleteTheme(theme) },
    ] }]);
  };
  const newMenu = (anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const taken = list.map((item) => item.id);
    const start = (from: Omit<CustomTheme, 'id' | 'name'>, name: string) => props.onEdit({ ...from, id: themeIdFor(name, taken), name }, true);
    openContextMenu(rect.left, rect.bottom + 4, [
      { title: 'Start from', items: [
        { label: 'Autark', onSelect: () => start(AUTARK_LOOK, 'My theme') },
        ...THEME_PRESETS.map((preset) => ({ label: preset.name, onSelect: () => start(preset, preset.name) })),
      ] },
      { items: [{ label: 'Import a theme file…', onSelect: () => fileInput.current?.click() }] },
    ]);
  };
  const onImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const theme = importTheme(await file.text(), list.map((item) => item.id));
      await saveThemes([...list, theme], theme.id);
      pushToast({ title: `Theme "${theme.name}" imported`, tone: 'info' }, 2500);
    } catch (error) { toastError(error, 'Could not import the theme'); }
  };
  return (
    <div class="theme-cards" role="radiogroup" aria-label="Themes">
      {[AUTARK_CARD, ...list].map((theme) => (
        <div key={theme.id || 'autark'} class="theme-card" role="radio" tabIndex={0} aria-checked={theme.id === active} data-theme-id={theme.id || 'autark'}
          onClick={() => chooseTheme(theme.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseTheme(theme.id); } }}>
          <Swatch theme={theme} dark={dark} />
          <span class="theme-card-name">
            <span>{theme.name}</span>
            {theme.id && <IconButton icon="dots-three" label={`More for ${theme.name}`} size="small"
              onClick={(event) => { event.stopPropagation(); cardMenu(theme, event.currentTarget as HTMLElement); }} />}
          </span>
        </div>
      ))}
      <button type="button" class="theme-card theme-card-new" onClick={(event) => newMenu(event.currentTarget as HTMLElement)}>
        <span class="theme-swatch" style={{ '--sw-side': 'var(--hover)', '--sw-bg': 'var(--surface)' }} aria-hidden="true"><i /><i /></span>
        <span class="theme-card-name"><span>New theme…</span><Icon name="plus" size={14} /></span>
      </button>
      <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="Theme file"
        onChange={(event) => { const input = event.currentTarget as HTMLInputElement; void onImport(input.files?.[0]); input.value = ''; }} />
    </div>
  );
}

function downloadTheme(theme: CustomTheme): void {
  const url = URL.createObjectURL(new Blob([exportTheme(theme)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = themeFileName(theme);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function deleteTheme(theme: CustomTheme): Promise<void> {
  if (!await confirm({ title: `Delete the theme "${theme.name}"?`, body: 'Its colours and sizes are gone; export it first to keep a copy.', confirmLabel: 'Delete', danger: true })) return;
  const rest = themes.peek().filter((item) => item.id !== theme.id);
  await saveThemes(rest, activeThemeId.peek() === theme.id ? '' : activeThemeId.peek()).catch((error) => toastError(error));
}

function ColorField(props: { label: string; value: string; empty: string; onChange(value: string): void; against?: string }) {
  const { value } = props;
  const ratio = value && props.against ? contrastRatio(value, props.against) : 0;
  return (
    <div class="theme-field">
      <span class="theme-field-label">{props.label}</span>
      <div class="theme-field-value">
        <span class="theme-color">
          <input type="color" aria-label={props.label} value={value || props.empty} onInput={(event) => props.onChange((event.currentTarget as HTMLInputElement).value)} />
          <input type="text" class="set-input narrow" aria-label={`${props.label} as hex`} value={value} placeholder="Autark" maxLength={7}
            onChange={(event) => { const text = (event.currentTarget as HTMLInputElement).value.trim(); if (!text || /^#[0-9a-f]{6}$/i.test(text)) props.onChange(text.toLowerCase()); }} />
        </span>
        {value && <ActionButton variant="ghost" label="Autark's" onClick={() => props.onChange('')} />}
        {ratio > 0 && <span class={`theme-contrast${ratio < 4.5 ? ' low' : ''}`}>{ratio < 4.5 ? `Text hard to read (${ratio.toFixed(1)}:1)` : `Text contrast ${ratio.toFixed(1)}:1`}</span>}
      </div>
    </div>
  );
}

function Range(props: { label: string; value: number; min: number; max: number; step?: number; unit: string; onChange(value: number): void }) {
  return (
    <div class="theme-field">
      <label>{props.label}</label>
      <div class="theme-field-value">
        <input type="range" aria-label={props.label} min={props.min} max={props.max} step={props.step ?? 1} value={props.value}
          onInput={(event) => props.onChange(Number((event.currentTarget as HTMLInputElement).value))} />
        <output>{props.value}{props.unit}</output>
      </div>
    </div>
  );
}

/** The draft theme in two small windows, light and dark. */
function Preview(props: { theme: CustomTheme }) {
  const css = themeCss(props.theme, '.preview-light', 'light') + themeCss(props.theme, '.preview-dark', 'dark');
  const window = (scheme: 'light' | 'dark') => (
    <div class={`preview-window preview-${scheme}`} data-scheme={scheme} aria-label={`Preview, ${scheme}`}>
      <span class="pv-bar" />
      <span class="pv-side"><i /><i /><i /></span>
      <span class="pv-main">
        <span class="pv-bubble">Can you look at the launch plan?</span>
        <span class="pv-text">Sure – I read it and left three notes in the chat's tabs.</span>
        <span class="pv-row"><span class="pv-button">Send</span><span class="pv-chip">Later</span></span>
      </span>
    </div>
  );
  return (
    <div class="theme-preview">
      <style>{css}</style>
      <div class="theme-preview-pair">{window('light')}{window('dark')}</div>
      <span class="preview-caption">The whole window shows this draft until you save or cancel.</span>
    </div>
  );
}

function ThemeEditor(props: { theme: CustomTheme; isNew: boolean; onDone(): void }) {
  const draft = themeDraft.value ?? props.theme;
  const set = (patch: Partial<CustomTheme>) => { themeDraft.value = { ...draft, ...patch }; };
  const save = async () => {
    const name = draft.name.trim() || 'My theme';
    const list = themes.peek();
    const theme = { ...draft, name };
    const next = list.some((item) => item.id === theme.id) ? list.map((item) => (item.id === theme.id ? theme : item)) : [...list, theme];
    try { await saveThemes(next, theme.id); themeDraft.value = null; props.onDone(); } catch (error) { toastError(error, 'Could not save the theme'); }
  };
  const cancel = () => { themeDraft.value = null; props.onDone(); };
  return (
    <Group title={props.isNew ? 'New theme' : `Edit "${props.theme.name}"`} id="settings-theme-editor">
      <div class="theme-editor">
        <div class="theme-fields">
          <div class="theme-field">
            <label for="theme-name">Name</label>
            <div class="theme-field-value"><input id="theme-name" class="set-input" maxLength={THEME_LIMITS.name} value={draft.name} onInput={(event) => set({ name: (event.currentTarget as HTMLInputElement).value })} /></div>
          </div>
          <ColorField label="Accent colour" value={draft.accent} empty="#1a1c1f" onChange={(accent) => set({ accent })} />
          <ColorField label="Background, light" value={draft.background} empty="#ffffff" against={SCHEME_TEXT.light} onChange={(background) => set({ background })} />
          <ColorField label="Background, dark" value={draft.backgroundDark} empty="#2b2b2b" against={SCHEME_TEXT.dark} onChange={(backgroundDark) => set({ backgroundDark })} />
          <div class="theme-field">
            <label for="theme-font">Font</label>
            <div class="theme-field-value">
              <input id="theme-font" class="set-input" list="theme-fonts" placeholder="System font" maxLength={THEME_LIMITS.font} value={draft.font}
                onInput={(event) => { const font = (event.currentTarget as HTMLInputElement).value; if (/^[\p{L}\p{N} ._-]{0,60}$/u.test(font)) set({ font }); }} />
              <datalist id="theme-fonts">{FONT_SUGGESTIONS.map((font) => <option key={font} value={font} />)}</datalist>
            </div>
          </div>
          <Range label="Text size" value={draft.textSize} min={THEME_LIMITS.textSize[0]} max={THEME_LIMITS.textSize[1]} step={5} unit="%" onChange={(textSize) => set({ textSize })} />
          <div class="theme-field">
            <span class="theme-field-label">Density</span>
            <div class="theme-field-value"><Segmented label="Density" value={draft.density} options={DENSITIES.map((value) => ({ value, label: DENSITY_LABELS[value] }))} onChange={(density) => set({ density })} /></div>
          </div>
          <Range label="Corner radius" value={draft.radius} min={THEME_LIMITS.radius[0]} max={THEME_LIMITS.radius[1]} unit=" px" onChange={(radius) => set({ radius })} />
          <div class="theme-actions">
            <ActionButton variant="primary" label="Save theme" onClick={() => void save()} />
            <ActionButton label="Cancel" onClick={cancel} />
            <ActionButton variant="ghost" label="Export…" onClick={() => downloadTheme(draft)} />
          </div>
        </div>
        <Preview theme={draft} />
      </div>
    </Group>
  );
}

/** The window in small: the chat's tabs drag to a side of the chat, its top, bottom or middle; sidebar and pane toggle. */
function LayoutMap() {
  const prefs = preferences.value;
  const dock = chatDock.value;
  const chat = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ place: DockPlace; box: { left: number; top: number; width: number; height: number } } | null>(null);
  const target = (event: PointerEvent): DockPlace | null => {
    const rect = chat.current?.getBoundingClientRect();
    return rect ? dockPlaceAt({ x: event.clientX, y: event.clientY }, { x: rect.left, y: rect.top, width: rect.width, height: rect.height }) : null;
  };
  const guide = (place: DockPlace) => {
    const rect = chat.current?.getBoundingClientRect();
    if (!rect) return null;
    const w = rect.width * 0.38; const h = rect.height * 0.36;
    const box = place === 'right' ? { left: rect.width - w, top: 0, width: w, height: rect.height }
      : place === 'left' ? { left: 0, top: 0, width: w, height: rect.height }
        : place === 'top' ? { left: 0, top: 0, width: rect.width, height: h }
          : place === 'bottom' ? { left: 0, top: rect.height - h, width: rect.width, height: h }
            : { left: rect.width * 0.18, top: rect.height * 0.16, width: rect.width * 0.52, height: rect.height * 0.56 };
    return { place, box };
  };
  const onDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => { const place = target(next); setDrop(place ? guide(place) : null); };
    const up = (last: PointerEvent) => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel);
      const place = target(last);
      setDrop(null);
      if (place && place !== dock.place) dockAt(place);
    };
    const cancel = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel); setDrop(null); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel);
  };
  return (
    <div class="layout-map" style={{ '--map-side': prefs.sidebarWidth, '--map-pane': prefs.workspaceWidth }} aria-label="The window's layout">
      <button type="button" class={`layout-map-side${prefs.sidebarOpen ? '' : ' hidden-part'}`} aria-pressed={prefs.sidebarOpen}
        title={prefs.sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar'} onClick={() => setPrefs({ sidebarOpen: !prefs.sidebarOpen })}>
        {prefs.sidebarOpen ? 'Sidebar' : ''}
      </button>
      <div ref={chat} class="layout-map-chat" data-dock={dock.place}>
        <div class="layout-map-messages">Chat</div>
        <div class="layout-map-dock" role="button" tabIndex={0} aria-label={`Chat tabs: ${DOCK_LABELS[dock.place]}. Drag to move.`} onPointerDown={onDown}
          onKeyDown={(event) => {
            const order = DOCK_PLACES;
            if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
            event.preventDefault();
            const at = order.indexOf(dock.place);
            dockAt(order[(at + (event.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length]);
          }}>
          <span><Icon name="dots-six-vertical" size={14} /> Chat tabs</span>
        </div>
        {drop && <span class="layout-map-drop" style={{ left: `${drop.box.left}px`, top: `${drop.box.top}px`, width: `${drop.box.width}px`, height: `${drop.box.height}px` }} />}
      </div>
      <button type="button" class={`layout-map-pane${prefs.workspaceOpen ? '' : ' hidden-part'}`} aria-pressed={prefs.workspaceOpen}
        title={prefs.workspaceOpen ? 'Hide the browser pane' : 'Show the browser pane'} onClick={() => setPrefs({ workspaceOpen: !prefs.workspaceOpen })}>
        {prefs.workspaceOpen ? 'Browser' : ''}
      </button>
    </div>
  );
}

/** The panels a new tab offers, in their order: drag (or Move up/down) to order, the switch hides or shows. */
function PanelOrder() {
  const order = panelOrder.value;
  const hidden = new Set(hiddenPanels.value);
  const dragged = useRef<PanelKind | null>(null);
  const [over, setOver] = useState<{ kind: PanelKind; side: 'before' | 'after' } | null>(null);
  const place = (kind: PanelKind, to: number) => {
    const rest = order.filter((item) => item !== kind);
    const at = Math.max(0, Math.min(to, rest.length));
    void savePanels([...rest.slice(0, at), kind, ...rest.slice(at)], [...hidden]).catch((error) => toastError(error));
  };
  return (
    <ul class="panel-order" aria-label="Panels in a new tab">
      {order.map((kind, index) => (
        <li key={kind} class={hidden.has(kind) ? 'panel-off' : ''} data-panel={kind} data-drop={over?.kind === kind ? over.side : undefined} draggable
          onDragStart={(event) => { dragged.current = kind; event.dataTransfer?.setData('application/x-autark-panel', kind); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => { dragged.current = null; setOver(null); }}
          onDragOver={(event) => {
            if (!dragged.current || dragged.current === kind) return;
            event.preventDefault();
            const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const side = event.clientY < box.top + box.height / 2 ? 'before' : 'after';
            if (over?.kind !== kind || over.side !== side) setOver({ kind, side });
          }}
          onDrop={(event) => {
            event.preventDefault();
            const from = dragged.current;
            setOver(null);
            if (!from || from === kind) return;
            const rest = order.filter((item) => item !== from);
            const at = rest.indexOf(kind) + (over?.side === 'after' ? 1 : 0);
            place(from, at);
          }}>
          <span class="panel-grip" aria-hidden="true"><Icon name="dots-six-vertical" size={16} /></span>
          <Toggle label={`Show ${PANEL_LABELS[kind]} in a new tab`} checked={!hidden.has(kind)}
            onChange={(on) => { const next = new Set(hidden); if (on) next.delete(kind); else next.add(kind); void savePanels(order, [...next]).catch((error) => toastError(error)); }} />
          <span class="panel-name">{PANEL_LABELS[kind]}</span>
          <span>
            <IconButton icon="caret-up" label={`Move ${PANEL_LABELS[kind]} up`} size="small" disabled={index === 0} onClick={() => place(kind, index - 1)} />
            <IconButton icon="caret-down" label={`Move ${PANEL_LABELS[kind]} down`} size="small" disabled={index === order.length - 1} onClick={() => place(kind, index + 1)} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function SizeRow(props: { label: string; value: number; min: number; max: number; onCommit(value: number): void }) {
  const [live, setLive] = useState<number | null>(null);
  return (
    <Row label={props.label}>
      <span class="theme-field-value" style={{ width: '280px' }}>
        <input type="range" aria-label={props.label} min={props.min} max={props.max} step={4} value={live ?? props.value}
          onInput={(event) => setLive(Number((event.currentTarget as HTMLInputElement).value))}
          onChange={(event) => { setLive(null); props.onCommit(Number((event.currentTarget as HTMLInputElement).value)); }} />
        <output>{live ?? props.value} px</output>
      </span>
    </Row>
  );
}

export function AppearancePage() {
  const prefs = preferences.value;
  const dock = chatDock.value;
  const [editing, setEditing] = useState<{ theme: CustomTheme; isNew: boolean } | null>(null);
  const edit = (theme: CustomTheme, isNew: boolean) => { themeDraft.value = theme; setEditing({ theme, isNew }); };
  const reset = async () => {
    if (!await confirm({ title: 'Reset the look and layout?', body: 'Autark\'s own theme, the System colour scheme, the chat\'s tabs on the right, the panels in their first order and the sidebar and pane at their first sizes. Your own themes stay in the list.', confirmLabel: 'Reset' })) return;
    themeDraft.value = null;
    setEditing(null);
    await resetAppearance().then(() => pushToast({ title: 'Back to the default look and layout', tone: 'info' }, 2500), (error) => toastError(error));
  };
  return (
    <div class="appearance-page" data-tour="appearance">
      <Group title="Theme" id="settings-theme" actions={<ActionButton label="Reset to default" onClick={() => void reset()} />}>
        <Row label="Colour scheme" hint="System follows this PC's light or dark setting">
          <Segmented label="Colour scheme" value={prefs.theme} options={[...SCHEMES]} onChange={(theme) => void setPrefs({ theme })} />
        </Row>
        <ThemeCards onEdit={edit} />
      </Group>
      {editing && <ThemeEditor key={editing.theme.id} theme={editing.theme} isNew={editing.isNew} onDone={() => setEditing(null)} />}
      <Group title="Layout" id="settings-layout" hint="Drag the chat's tabs to a side of the chat, to its top or bottom, or into it to float. Click the sidebar or the browser pane to show or hide it.">
        <LayoutMap />
        <Row label="Chat tabs" hint={DOCK_LABELS[dock.place]}>
          <Segmented label="Where the chat's tabs sit" value={dock.place} options={PLACE_OPTIONS} onChange={(place) => dockAt(place)} />
        </Row>
        {(dock.place === 'right' || dock.place === 'left') && <SizeRow label="Chat tabs width" value={dock.width} min={260} max={1000} onCommit={(width) => void saveDock({ width }).catch((error) => toastError(error))} />}
        {(dock.place === 'top' || dock.place === 'bottom') && <SizeRow label="Chat tabs height" value={dock.height} min={140} max={800} onCommit={(height) => void saveDock({ height }).catch((error) => toastError(error))} />}
        {dock.place === 'float' && <SizeRow label="Floating window width" value={dock.floatWidth} min={280} max={1400} onCommit={(floatWidth) => void saveDock({ floatWidth }).catch((error) => toastError(error))} />}
        {dock.place === 'float' && <SizeRow label="Floating window height" value={dock.floatHeight} min={200} max={1000} onCommit={(floatHeight) => void saveDock({ floatHeight }).catch((error) => toastError(error))} />}
        <Row label="Sidebar"><Toggle label="Show the sidebar" checked={prefs.sidebarOpen} onChange={(sidebarOpen) => void setPrefs({ sidebarOpen })} /></Row>
        <SizeRow label="Sidebar width" value={prefs.sidebarWidth} min={200} max={420} onCommit={(sidebarWidth) => void setPrefs({ sidebarWidth })} />
        <Row label="Browser pane"><Toggle label="Show the browser pane" checked={prefs.workspaceOpen} onChange={(workspaceOpen) => void setPrefs({ workspaceOpen })} /></Row>
        <SizeRow label="Browser pane width" value={prefs.workspaceWidth} min={280} max={800} onCommit={(workspaceWidth) => void setPrefs({ workspaceWidth })} />
      </Group>
      <Group title="Panels in a new tab" id="settings-panels" hint="A blank tab offers these panels in this order. Drag them, or use the arrows; the switch hides one.">
        <PanelOrder />
      </Group>
    </div>
  );
}


