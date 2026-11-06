// Which space a surface shows – GLOBAL_SPACE in the person's pane, a chat's 'chat:<id>' in its area above the messages,
// an agent's 'agent:<id>' in its own area on the agent page (the agent keeps it):
// WorkspacePane.tsx provides it, and its parts (the strip, the address row, the menus, the panels) read it, so one set of
// parts serves both surfaces. Outside a surface there is none (undefined: a message's image opens in its chat's area).
// Owns: that context. Never: what a space holds (pages.ts).

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { GLOBAL_SPACE } from '../../shared/api/workspace-browser.ts';

export const SpaceContext = createContext<string | undefined>(undefined);

/** The space of the surface this part is drawn in (global outside one). */
export function useSpace(): string {
  return useContext(SpaceContext) ?? GLOBAL_SPACE;
}
