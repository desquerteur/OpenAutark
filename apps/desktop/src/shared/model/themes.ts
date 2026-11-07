// AF-008: the person's own themes (settings.json › appearance.themes, the one in use: appearance.theme; Settings ›
// Appearance builds them with a live preview). A theme changes the accent colour, the content's background (one for the
// light and one for the dark scheme – Dark/Light/System stays preferences.theme), the font and its size, the density
// and the corner radius; whatever it leaves empty stays Autark's own. The window turns a theme into CSS custom
// properties (themeCss) that lie under <data>/theme.css, so a hand-written theme.css still wins. A theme travels as a
// small JSON file (exportTheme/importTheme).
// Owns: the theme's shape, its limits, its checks, its CSS and its file. Never: the DOM, files or settings writes.

export type Density = 'compact' | 'regular' | 'comfortable';
export const DENSITIES: readonly Density[] = ['compact', 'regular', 'comfortable'];

export interface CustomTheme {
  /** [a-z0-9-], unique among the themes. */
  id: string;
  name: string;
  /** '#rrggbb', or '' for Autark's own (no accent colour). */
  accent: string;
  /** The content's background in the light scheme, '#rrggbb' or ''. */
  background: string;
  /** The content's background in the dark scheme, '#rrggbb' or ''. */
  backgroundDark: string;
  /** A font installed on this PC by name, or '' for the system font. */
  font: string;
  /** Text and controls in percent of Autark's own size. */
  textSize: number;
  density: Density;
  /** The medium corner radius in px (Autark's own: 10; the other radii follow it). */
  radius: number;
}

export const THEME_LIMITS = { textSize: [85, 130], radius: [0, 20], name: 40, font: 60, themes: 24 } as const;
export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** A font by its name: letters, digits, spaces, dots, dashes – never quotes, semicolons or braces (it goes into CSS). */
export const FONT_NAME = /^[\p{L}\p{N} ._-]{0,60}$/u;
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Autark's own look as a theme (the editor starts here; every empty value means this). */
export const AUTARK_LOOK: Omit<CustomTheme, 'id' | 'name'> = {
  accent: '', background: '', backgroundDark: '', font: '', textSize: 100, density: 'regular', radius: 10,
};

/** Ready-made starting points (the person changes and saves them as their own). */
export const THEME_PRESETS: readonly CustomTheme[] = [
  { id: 'ocean', name: 'Ocean', accent: '#1f6fd1', background: '#f6f9fd', backgroundDark: '#1d2430', font: '', textSize: 100, density: 'regular', radius: 12 },
  { id: 'forest', name: 'Forest', accent: '#2f7d57', background: '#f7faf7', backgroundDark: '#1f2622', font: '', textSize: 100, density: 'regular', radius: 8 },
  { id: 'sunset', name: 'Sunset', accent: '#c4542d', background: '#fffaf6', backgroundDark: '#2a2220', font: 'Georgia', textSize: 105, density: 'comfortable', radius: 16 },
  { id: 'compact-mono', name: 'Compact', accent: '#6b4fb0', background: '', backgroundDark: '', font: '', textSize: 92, density: 'compact', radius: 4 },
];

const clampInt = (value: unknown, [min, max]: readonly [number, number], fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : fallback;
const colorOr = (value: unknown): string => (typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : '');

/** A theme id from a name ('My Theme 2' → 'my-theme-2'), unique against `taken`. */
export function themeIdFor(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'theme';
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** A forgiving read of one theme (an import, an older file): unusable values take Autark's own; undefined without a name. */
export function themeOf(value: unknown, taken: Iterable<string> = []): CustomTheme | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, THEME_LIMITS.name) : '';
  if (!name) return undefined;
  const used = [...taken];
  const id = typeof raw.id === 'string' && THEME_ID.test(raw.id) && !used.includes(raw.id) ? raw.id : themeIdFor(name, used);
  return {
    id, name,
    accent: colorOr(raw.accent),
    background: colorOr(raw.background),
    backgroundDark: colorOr(raw.backgroundDark),
    font: typeof raw.font === 'string' && FONT_NAME.test(raw.font.trim()) ? raw.font.trim() : '',
    textSize: clampInt(raw.textSize, THEME_LIMITS.textSize, AUTARK_LOOK.textSize),
    density: DENSITIES.includes(raw.density as Density) ? raw.density as Density : AUTARK_LOOK.density,
    radius: clampInt(raw.radius, THEME_LIMITS.radius, AUTARK_LOOK.radius),
  };
}

/** The first problem of a written theme list (settings.json's check), or undefined. */
export function themesProblem(value: unknown): { path: string; expected: string } | undefined {
  if (!Array.isArray(value)) return { path: 'themes', expected: 'a list of themes' };
  if (value.length > THEME_LIMITS.themes) return { path: 'themes', expected: `at most ${THEME_LIMITS.themes} themes` };
  const ids = new Set<string>();
  for (const [index, item] of value.entries()) {
    const at = `themes[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { path: at, expected: 'a theme object' };
    const raw = item as Record<string, unknown>;
    const known = ['id', 'name', 'accent', 'background', 'backgroundDark', 'font', 'textSize', 'density', 'radius'];
    for (const key of Object.keys(raw)) if (!known.includes(key)) return { path: `${at}.${key}`, expected: 'a known key' };
    if (typeof raw.id !== 'string' || !THEME_ID.test(raw.id)) return { path: `${at}.id`, expected: 'lower-case letters, digits and dashes' };
    if (ids.has(raw.id)) return { path: `${at}.id`, expected: 'an id no other theme has' };
    ids.add(raw.id);
    if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > THEME_LIMITS.name || /[\u0000-\u001f]/.test(raw.name)) return { path: `${at}.name`, expected: `a name up to ${THEME_LIMITS.name} characters` };
    for (const key of ['accent', 'background', 'backgroundDark'] as const) {
      if (typeof raw[key] !== 'string' || (raw[key] !== '' && !HEX_COLOR.test(raw[key] as string))) return { path: `${at}.${key}`, expected: 'a colour like "#1f6fd1", or ""' };
    }
    if (typeof raw.font !== 'string' || !FONT_NAME.test(raw.font)) return { path: `${at}.font`, expected: 'a font name (letters, digits, spaces), or ""' };
    if (!Number.isInteger(raw.textSize) || (raw.textSize as number) < THEME_LIMITS.textSize[0] || (raw.textSize as number) > THEME_LIMITS.textSize[1]) return { path: `${at}.textSize`, expected: `a whole number from ${THEME_LIMITS.textSize[0]} to ${THEME_LIMITS.textSize[1]}` };
    if (!DENSITIES.includes(raw.density as Density)) return { path: `${at}.density`, expected: DENSITIES.join(' | ') };
    if (!Number.isInteger(raw.radius) || (raw.radius as number) < THEME_LIMITS.radius[0] || (raw.radius as number) > THEME_LIMITS.radius[1]) return { path: `${at}.radius`, expected: `a whole number from ${THEME_LIMITS.radius[0]} to ${THEME_LIMITS.radius[1]}` };
  }
  return undefined;
}

// ---------------------------------------------------------------- colour

/** '#rrggbb' → [r, g, b] 0..255. */
export function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of '#rrggbb'. */
export function luminance(hex: string): number {
  const [r, g, b] = rgbOf(hex).map((part) => { const c = part / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two '#rrggbb' colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** Text that reads on `background`: white or near-black, whichever contrasts more. */
export function readableOn(background: string): '#ffffff' | '#111111' {
  return contrastRatio('#ffffff', background) >= contrastRatio('#111111', background) ? '#ffffff' : '#111111';
}

/** Autark's own text colour per scheme (tokens.css), for the editor's contrast line. */
export const SCHEME_TEXT = { light: '#1a1c1f', dark: '#ececec' } as const;

// ---------------------------------------------------------------- CSS

const DENSITY_SIZES: Readonly<Record<Density, { row: number; set: number; gap: number }>> = {
  compact: { row: 48, set: 48, gap: 16 },
  regular: { row: 56, set: 56, gap: 24 },
  comfortable: { row: 64, set: 64, gap: 32 },
};
/** tokens.css's radii at a medium radius of 10 px. */
const RADII: ReadonlyArray<[string, number]> = [['--r-xs', 5], ['--r-sm', 7], ['--r-md', 10], ['--r-lg', 12], ['--r-xl', 14], ['--r-shell', 18], ['--r-composer', 20]];
const SYSTEM_FONTS = '"Segoe UI", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';

const mix = (color: string, share: number, other: string) => `color-mix(in srgb, ${color} ${share}%, ${other})`;

/** The light scheme's content colours from one background (tokens.css's steps from white). */
function lightSurfaces(bg: string): string[] {
  return [
    `--surface: ${bg}`, `--elevated: ${bg}`,
    `--hover: ${mix(bg, 91, '#000')}`, `--selected: ${mix(bg, 87, '#000')}`, `--line: ${mix(bg, 85, '#000')}`,
    `--elevated-hover: ${mix(bg, 91, '#000')}`, `--elevated-selected: ${mix(bg, 87, '#000')}`, `--elevated-line: ${mix(bg, 85, '#000')}`,
    `--field: ${mix(bg, 82, '#000')}`,
  ];
}

/** The dark scheme's content colours from one background (tokens.css's steps from #2b2b2b). */
function darkSurfaces(bg: string): string[] {
  return [
    `--surface: ${bg}`, `--elevated: ${mix(bg, 90, '#fff')}`,
    `--hover: ${mix(bg, 94, '#fff')}`, `--selected: ${mix(bg, 88, '#fff')}`, `--line: ${mix(bg, 86, '#fff')}`,
    `--elevated-hover: ${mix(bg, 84, '#fff')}`, `--elevated-selected: ${mix(bg, 80, '#fff')}`, `--elevated-line: ${mix(bg, 76, '#fff')}`,
    `--field: ${mix(bg, 80, '#fff')}`,
  ];
}

const block = (selector: string, lines: readonly string[]) => (lines.length ? `${selector} {\n  ${lines.join(';\n  ')};\n}\n` : '');

/**
 * The CSS of `theme` (custom properties only; styles/appearance.css uses --accent where Autark has none). `scope` is
 * the root selector – ':root' for the window, a preview's own class for the editor's sample – and `scheme` says which
 * scheme a scope that is not the root shows (the root follows data-theme and, for System, the PC).
 */
export function themeCss(theme: Omit<CustomTheme, 'id' | 'name'>, scope = ':root', scheme?: 'light' | 'dark'): string {
  const common: string[] = [];
  if (theme.accent) {
    const fg = readableOn(theme.accent);
    common.push(`--accent: ${theme.accent}`, `--accent-fg: ${fg}`, `--badge-bg: ${theme.accent}`, `--badge-fg: ${fg}`,
      `--update: ${theme.accent}`, `--update-hover: ${mix(theme.accent, 86, '#000')}`, `--focus: ${theme.accent}`,
      `--wf-accent: ${theme.accent}`, `--wf-accent-fg: ${fg}`);
  }
  if (theme.font) common.push(`--font: "${theme.font}", ${SYSTEM_FONTS}`);
  if (theme.radius !== AUTARK_LOOK.radius) for (const [name, at10] of RADII) common.push(`${name}: ${Math.round((at10 * theme.radius) / 10)}px`);
  if (theme.density !== AUTARK_LOOK.density) {
    const size = DENSITY_SIZES[theme.density];
    common.push(`--row-h: ${size.row}px`, `--set-row-h: ${size.set}px`, `--msg-gap: ${size.gap}px`);
  }
  if (theme.textSize !== AUTARK_LOOK.textSize) common.push(`--text-zoom: ${theme.textSize / 100}`);
  const light = theme.background ? lightSurfaces(theme.background) : [];
  const dark = theme.backgroundDark ? darkSurfaces(theme.backgroundDark) : [];
  if (scope !== ':root') return block(scope, [...common, ...(scheme === 'dark' ? dark : light)]);
  return [
    block(':root', common),
    block(':root[data-theme=light]', light),
    light.length ? `@media (prefers-color-scheme: light) {\n${block(':root[data-theme=system]', light)}}\n` : '',
    block(':root[data-theme=dark]', dark),
    dark.length ? `@media (prefers-color-scheme: dark) {\n${block(':root[data-theme=system]', dark)}}\n` : '',
  ].join('');
}

// ---------------------------------------------------------------- the theme file

/** The file a theme travels in: `{ "autarkTheme": 1, …the theme without its id }`. */
export function exportTheme(theme: CustomTheme): string {
  const { id: _id, ...rest } = theme;
  return `${JSON.stringify({ autarkTheme: 1, ...rest }, null, 2)}\n`;
}

/** The name a theme's file gets ('Ocean blue' → 'ocean-blue.autark-theme.json'). */
export function themeFileName(theme: Pick<CustomTheme, 'name'>): string {
  return `${themeIdFor(theme.name)}.autark-theme.json`;
}

/** A theme from a file's text, with an id none of `taken` has; throws an Error saying what is wrong. */
export function importTheme(text: string, taken: Iterable<string> = []): CustomTheme {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error('This file is not a theme (it is not JSON).'); }
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).autarkTheme !== 1) throw new Error('This file is not an Autark theme.');
  const theme = themeOf({ ...(data as Record<string, unknown>), id: undefined }, taken);
  if (!theme) throw new Error('The theme has no name.');
  return theme;
}
