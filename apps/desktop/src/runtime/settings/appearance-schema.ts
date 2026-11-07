// settings.json › appearance (AF-010/AF-008, Settings › Appearance): the definitions of its keys for schema.ts's one table
// (comments, settings.schema.json, defaults) and its value check for validate.ts. The shapes, defaults and limits are
// shared/model/appearance.ts and shared/model/themes.ts, so the window, the file's comments and the checks never disagree.
// Owns: these definitions and the check. Never: reads or writes files.

import { WorkforceError } from '../../shared/errors.ts';
import { DEFAULT_CHAT_DOCK, DEFAULT_PANELS, DOCK_LIMITS, DOCK_PLACES, appearanceProblem, chatDockProblem } from '../../shared/model/appearance.ts';
import { DENSITIES, THEME_LIMITS } from '../../shared/model/themes.ts';
import type { KeyDef, SectionDef } from './schema.ts';

const int = (key: keyof typeof DOCK_LIMITS, about: string): KeyDef =>
  ({ key, about, type: 'integer', min: DOCK_LIMITS[key][0], max: DOCK_LIMITS[key][1], default: DEFAULT_CHAT_DOCK[key] });

const THEME_SCHEMA = {
  maxItems: THEME_LIMITS.themes,
  items: {
    type: 'object', additionalProperties: false, required: ['id', 'name', 'accent', 'background', 'backgroundDark', 'font', 'textSize', 'density', 'radius'],
    properties: {
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$' },
      name: { type: 'string', minLength: 1, maxLength: THEME_LIMITS.name },
      accent: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$' },
      background: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$' },
      backgroundDark: { type: 'string', pattern: '^(#[0-9a-fA-F]{6})?$' },
      font: { type: 'string', maxLength: THEME_LIMITS.font },
      textSize: { type: 'integer', minimum: THEME_LIMITS.textSize[0], maximum: THEME_LIMITS.textSize[1] },
      density: { type: 'string', enum: DENSITIES },
      radius: { type: 'integer', minimum: THEME_LIMITS.radius[0], maximum: THEME_LIMITS.radius[1] },
    },
  },
};

export const APPEARANCE_SECTION: SectionDef = { key: 'appearance', title: 'Look and layout (Settings › Appearance)', keys: [
  { key: 'chatDock', about: 'Where a chat\'s tabs (browser, notes, media, files …) sit beside its messages, and their size', type: 'object', keys: [
    { key: 'place', about: 'right or left of the messages, at the bottom or the top, or float = a window of its own over the chat', type: 'string', options: DOCK_PLACES, default: DEFAULT_CHAT_DOCK.place },
    int('width', 'Width in pixels when docked right or left (the chat keeps at least 340)'),
    int('height', 'Height in pixels when docked at the bottom or the top'),
    int('floatX', 'The floating window: pixels from the chat\'s left edge'),
    int('floatY', 'The floating window: pixels from the top of the chat under its header'),
    int('floatWidth', 'The floating window\'s width in pixels'),
    int('floatHeight', 'The floating window\'s height in pixels'),
  ] },
  { key: 'theme', about: 'The theme in use: the id of one of themes, or "" for Autark\'s own look (light/dark/system stays preferences.theme)', type: 'string',
    allowed: '"" or a theme id', maxLength: 40, default: '' },
  { key: 'themes', about: `Your own themes: { id, name, accent, background (light), backgroundDark, font, textSize (${THEME_LIMITS.textSize[0]}–${THEME_LIMITS.textSize[1]} %), density (${DENSITIES.join(' | ')}), radius (${THEME_LIMITS.radius[0]}–${THEME_LIMITS.radius[1]} px) }; colours "#rrggbb" or "" for Autark's own`, type: 'array',
    allowed: `a list of up to ${THEME_LIMITS.themes} themes`, default: [], schema: THEME_SCHEMA },
  { key: 'panels', about: 'The panels a new tab offers, in this order', type: 'array', options: DEFAULT_PANELS, default: [...DEFAULT_PANELS] },
  { key: 'hiddenPanels', about: 'Panels a new tab leaves out', type: 'array', options: DEFAULT_PANELS, default: [] },
] };

/** Checks settings.appearance (after merging); throws bad_request naming the first wrong key. */
export function validateAppearance(value: unknown): void {
  if (value === undefined) return;
  const fail = (path: string, expected: string): never => {
    throw new WorkforceError('bad_request', `Invalid setting appearance.${path}: expected ${expected}.`, { details: { path: `appearance.${path}` } });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('(section)', 'an object');
  const raw = value as Record<string, unknown>;
  const problem = chatDockProblem(raw.chatDock) ?? appearanceProblem(raw);
  if (problem) fail(problem.path, problem.expected);
}
