// settings.json › appearance (AF-010/AF-008, Settings › Appearance): the definitions of its keys for schema.ts's one table
// (comments, settings.schema.json, defaults) and its value check for validate.ts. The shapes, defaults and limits are
// shared/model/appearance.ts, so the window, the file's comments and the checks never disagree.
// Owns: these definitions and the check. Never: reads or writes files.

import { WorkforceError } from '../../shared/errors.ts';
import { DEFAULT_CHAT_DOCK, DOCK_LIMITS, DOCK_PLACES, chatDockProblem } from '../../shared/model/appearance.ts';
import type { KeyDef, SectionDef } from './schema.ts';

const int = (key: keyof typeof DOCK_LIMITS, about: string): KeyDef =>
  ({ key, about, type: 'integer', min: DOCK_LIMITS[key][0], max: DOCK_LIMITS[key][1], default: DEFAULT_CHAT_DOCK[key] });

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
] };

/** Checks settings.appearance (after merging); throws bad_request naming the first wrong key. */
export function validateAppearance(value: unknown): void {
  if (value === undefined) return;
  const fail = (path: string, expected: string): never => {
    throw new WorkforceError('bad_request', `Invalid setting appearance.${path}: expected ${expected}.`, { details: { path: `appearance.${path}` } });
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('(section)', 'an object');
  const raw = value as Record<string, unknown>;
  const problem = chatDockProblem(raw.chatDock);
  if (problem) fail(problem.path, problem.expected);
}
