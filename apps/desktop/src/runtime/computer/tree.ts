// UI Automation tree → compact text for agents (Playwright-snapshot style), plus the table of
// short element refs ("e12") the agent uses in computer.act.
// Owns: node shape from the helper, wrapper collapsing, line format and ref bookkeeping.
// Refs are keyed by window + UIA RuntimeId (identity of the live element, not its position in
// the tree), so a ref stays the same across observations while the element exists.
// Never: talks to the helper or acts on elements.

export interface UiNode {
  d: number; // depth in the helper walk
  p: number; // parent index (-1 = root)
  rid: string; // UIA RuntimeId joined with "."
  role: string; // control type, lowercase ("button", "edit", "menuitem" …)
  name?: string;
  aid?: string; // AutomationId
  cls?: string;
  rect?: [number, number, number, number]; // physical screen pixels x, y, width, height
  disabled?: boolean;
  offscreen?: boolean;
  focused?: boolean;
  patterns?: string[];
  value?: string | number;
  toggle?: string;
  expand?: string;
  selected?: boolean;
}

export interface RefTarget {
  hwnd: number;
  rid: string;
  name: string;
  role: string;
  rect?: [number, number, number, number];
  /** What it offered when observed (computer/quiet-actions.ts swaps a click for one of them). */
  patterns?: string[];
}

/** Structural roles that only wrap other elements; hidden when they carry no information. */
const WRAPPERS = new Set(['pane', 'group', 'custom', 'text', 'image', 'separator', 'thumb', 'unknown']);

/** Where new refs are numbered: one per table, or shared by the tables of one PC (unique refs across agents). */
export interface RefCounter { next: number }

/**
 * Bounded map of short refs (e1, e2 …) to live elements as one observer saw them; LRU eviction.
 * B-055: ComputerService keeps one table per agent with a shared counter, so a ref belongs to
 * exactly one agent's observation – another agent's later read of the same element (maybe renamed
 * meanwhile) can never change what this agent's ref expects, and never evicts it.
 */
export class RefTable {
  private byKey = new Map<string, string>();
  private byRef = new Map<string, RefTarget>();
  private readonly counter: RefCounter;
  private readonly cap: number;

  constructor(cap = 4000, counter: RefCounter = { next: 1 }) {
    this.cap = cap;
    this.counter = counter;
  }

  ref(target: RefTarget): string {
    const key = `${target.hwnd}:${target.rid}`;
    let ref = this.byKey.get(key);
    if (!ref) {
      ref = `e${this.counter.next++}`;
      this.byKey.set(key, ref);
    } else {
      this.byRef.delete(ref); // refresh LRU position
    }
    this.byRef.set(ref, target);
    while (this.byRef.size > this.cap) {
      const oldest = this.byRef.keys().next().value as string;
      const old = this.byRef.get(oldest)!;
      this.byRef.delete(oldest);
      this.byKey.delete(`${old.hwnd}:${old.rid}`);
    }
    return ref;
  }

  get(ref: string): RefTarget | undefined {
    return this.byRef.get(ref.trim().replace(/^\[?ref=/, '').replace(/\]$/, ''));
  }
}

function quote(value: string): string {
  return `"${value.replace(/\s+/g, ' ').replace(/"/g, '\\"')}"`;
}

/** True when a node is worth a line of its own. The root (index 0) is always kept. */
export function keepNode(node: UiNode, index: number): boolean {
  if (index === 0) return true;
  if (node.name || node.aid || node.value !== undefined || node.focused) return true;
  if (node.patterns?.length) return true;
  return !WRAPPERS.has(node.role);
}

/** One line for a node: `- button "Export" [ref=e12] (invoke) @812,430 [disabled]`. */
export function nodeLine(node: UiNode, ref: string): string {
  const parts = [`- ${node.role}`];
  if (node.name) parts.push(quote(node.name.slice(0, 200)));
  parts.push(`[ref=${ref}]`);
  if (node.aid && node.aid !== node.name) parts.push(`#${node.aid.slice(0, 80)}`);
  if (node.value !== undefined && node.value !== '') parts.push(`= ${typeof node.value === 'number' ? node.value : quote(String(node.value).slice(0, 300))}`);
  if (node.toggle) parts.push(`[${node.toggle}]`);
  if (node.expand && node.expand !== 'leafnode') parts.push(`[${node.expand}]`);
  if (node.selected) parts.push('[selected]');
  if (node.focused) parts.push('[focused]');
  if (node.disabled) parts.push('[disabled]');
  if (node.offscreen) parts.push('[offscreen]');
  const actions = (node.patterns ?? []).filter((pattern) => pattern !== 'value' || node.value === undefined);
  if (actions.length) parts.push(`(${actions.join(',')})`);
  if (node.rect && node.rect[2] > 0 && node.rect[3] > 0 && !node.offscreen) {
    parts.push(`@${Math.round(node.rect[0] + node.rect[2] / 2)},${Math.round(node.rect[1] + node.rect[3] / 2)}`);
  }
  return parts.join(' ');
}

/**
 * Renders helper nodes as an indented outline. Unnamed wrappers are collapsed: their children
 * move up one level. Every kept node gets a ref from `refs`.
 */
export function renderTree(nodes: UiNode[], hwnd: number, refs: RefTable): { text: string; count: number } {
  const level: number[] = [];
  const kept: boolean[] = [];
  const lines: string[] = [];
  nodes.forEach((node, index) => {
    const keep = keepNode(node, index);
    kept[index] = keep;
    const parent = node.p;
    const parentLevel = parent >= 0 && parent < index ? level[parent] : -1;
    const parentKept = parent >= 0 && parent < index ? kept[parent] : true;
    level[index] = parent < 0 ? 0 : parentKept ? parentLevel + 1 : parentLevel;
    if (!keep) return;
    const ref = refs.ref({ hwnd, rid: node.rid, name: node.name ?? '', role: node.role, rect: node.rect, ...(node.patterns ? { patterns: node.patterns } : {}) });
    lines.push(`${'  '.repeat(Math.max(0, level[index]))}${nodeLine(node, ref)}`);
  });
  return { text: lines.join('\n'), count: lines.length };
}

/** Plain-data parse of the helper's node list (drops malformed entries). */
export function parseNodes(value: unknown): UiNode[] {
  if (!Array.isArray(value)) return [];
  const out: UiNode[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const node = item as Record<string, unknown>;
    if (typeof node.rid !== 'string' || typeof node.role !== 'string') continue;
    const rect = Array.isArray(node.rect) && node.rect.length === 4 && node.rect.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? node.rect as [number, number, number, number] : undefined;
    out.push({
      d: typeof node.d === 'number' ? node.d : 0,
      p: typeof node.p === 'number' ? node.p : -1,
      rid: node.rid,
      role: node.role,
      name: typeof node.name === 'string' ? node.name : undefined,
      aid: typeof node.aid === 'string' ? node.aid : undefined,
      cls: typeof node.cls === 'string' ? node.cls : undefined,
      rect,
      disabled: node.disabled === true || undefined,
      offscreen: node.offscreen === true || undefined,
      focused: node.focused === true || undefined,
      patterns: Array.isArray(node.patterns) ? node.patterns.filter((p): p is string => typeof p === 'string') : undefined,
      value: typeof node.value === 'string' || typeof node.value === 'number' ? node.value : undefined,
      toggle: typeof node.toggle === 'string' ? node.toggle : undefined,
      expand: typeof node.expand === 'string' ? node.expand : undefined,
      selected: node.selected === true || undefined,
    });
  }
  return out;
}
