// Named pointers (B-055): who points where on a shared surface – the person's and every agent's
// cursor in a browser tab (side browser, chat browser, an agent's own browser) or on a PC's screen.
// Viewers draw them as named cursors; agents read them as one short line in their tool results
// ("Lukas (person) is pointing at button "Pay" [ref=e31], 2 s ago"), so they notice each other
// and can split the work. Kept in memory only (runtime/pointers/hub.ts), never stored.
// Owns: the shapes, the surface keys and the text line for agents. Never: behaviour or storage.

import type { MotionStep } from './pointer-motion.ts';

/** A pointer older than this is gone (no event needed to remove it). */
export const POINTER_TTL_MS = 15_000;
/** At most this many path steps travel with a pointer (viewers animate them). */
export const POINTER_PATH_MAX = 40;

export type PointerAction = 'move' | 'click' | 'type' | 'scroll' | 'select' | 'drag';

export interface PointerActor {
  kind: 'person' | 'agent';
  id: string;
  /** Display name ("Lukas", "Ada"); a person's role may follow in brackets ("Lukas (CEO)"). */
  name: string;
}

export interface PointerPoint {
  /** Surface key (see surfaceKey). */
  surface: string;
  actor: PointerActor;
  /** CSS px in the tab's viewport (browsers) or physical px of the virtual screen (screen). */
  x: number;
  y: number;
  /** What is under the pointer when known: role and accessible name (≤ 80 chars) and the agent's ref. */
  target?: { role?: string; name?: string; ref?: string };
  action?: PointerAction;
  /** An agent's move as steps (thinned to POINTER_PATH_MAX) so viewers animate the same path. */
  path?: MotionStep[];
  /** Epoch ms. */
  at: number;
}

/** Event payload 'pointers.changed': every live pointer of one surface. */
export interface PointerState {
  surface: string;
  points: PointerPoint[];
}

export type SurfaceKind = 'side' | 'chat' | 'agent' | 'screen';

/**
 * side:<tabId> – a tab of the person's side browser; chat:<chatId>/<tab> – a chat's shared browser;
 * agent:<agentId>/<tab> – an agent's own browser; screen:<deviceId|local> – a PC's screen.
 */
export function surfaceKey(kind: SurfaceKind, id: string, tab?: string): string {
  return tab ? `${kind}:${id}/${tab}` : `${kind}:${id}`;
}

export function parseSurface(key: string): { kind: SurfaceKind; id: string; tab?: string } | null {
  const match = /^(side|chat|agent|screen):([^/]+)(?:\/(.+))?$/.exec(key);
  if (!match) return null;
  return { kind: match[1] as SurfaceKind, id: match[2]!, ...(match[3] ? { tab: match[3] } : {}) };
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 2 ? 'just now' : `${s} s ago`;
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** One line per other pointer on a surface, for an agent's tool result; '' when nobody else is there. */
export function pointersLine(points: readonly PointerPoint[], selfId: string, now: number): string {
  const others = points.filter((p) => p.actor.id !== selfId && now - p.at < POINTER_TTL_MS);
  if (others.length === 0) return '';
  return others.map((p) => {
    const who = `${p.actor.name} (${p.actor.kind === 'person' ? 'person' : 'agent'})`;
    const verb = p.action === 'click' ? 'clicked' : p.action === 'type' ? 'is typing' : p.action === 'scroll' ? 'is scrolling' : 'is pointing';
    const target = p.target?.name || p.target?.role
      ? ` at ${p.target.role ?? 'element'}${p.target.name ? ` "${clip(p.target.name, 60)}"` : ''}${p.target.ref ? ` [ref=${p.target.ref}]` : ''}`
      : ` at ${Math.round(p.x)},${Math.round(p.y)}`;
    return `${who} ${verb}${target}, ${ago(now - p.at)}`;
  }).join('\n');
}
