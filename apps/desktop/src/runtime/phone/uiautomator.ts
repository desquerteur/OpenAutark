// Android `uiautomator dump` XML → element list and compact text for agents, plus `adb devices
// -l` parsing. Pure functions (no XML library): the dump is a flat, well-formed attribute
// format, so a small tag scanner is enough.
// Owns: node shape, bounds parsing, wrapper collapsing and the text outline.
// Never: runs adb or decides what to tap.

export interface PhoneNode {
  index: number; // position in the dump (document order)
  depth: number;
  parent: number; // -1 = root
  text?: string;
  desc?: string; // content-desc
  id?: string; // resource-id
  cls?: string; // short class name ("Button")
  pkg?: string;
  bounds?: [number, number, number, number]; // left, top, right, bottom (screen pixels)
  clickable?: boolean;
  scrollable?: boolean;
  checkable?: boolean;
  checked?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  password?: boolean;
}

export interface PhoneDevice {
  serial: string;
  state: string; // device | unauthorized | offline | …
  model?: string;
  product?: string;
  transport?: string;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** "[0,72][1080,210]" → [0, 72, 1080, 210]. */
export function parseBounds(value: string | undefined): [number, number, number, number] | undefined {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? '');
  if (!match) return undefined;
  const [, l, t, r, b] = match.map(Number);
  return r > l && b > t ? [l, t, r, b] : undefined;
}

/** Parses the XML of `uiautomator dump`. Unknown or malformed parts are skipped. */
export function parseDump(xml: string): PhoneNode[] {
  const nodes: PhoneNode[] = [];
  const stack: number[] = [];
  const tag = /<(\/?)node\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(xml))) {
    const [, closing, body, selfClosing] = match;
    if (closing) { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    for (const attr of body.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[attr[1]] = unescapeXml(attr[2]);
    const flag = (key: string) => attrs[key] === 'true';
    const cls = attrs.class ? attrs.class.split('.').pop() : undefined;
    const node: PhoneNode = {
      index: nodes.length,
      depth: stack.length,
      parent: stack.length ? stack[stack.length - 1] : -1,
      text: attrs.text || undefined,
      desc: attrs['content-desc'] || undefined,
      id: attrs['resource-id'] || undefined,
      cls,
      pkg: attrs.package || undefined,
      bounds: parseBounds(attrs.bounds),
      clickable: flag('clickable') || flag('long-clickable') || undefined,
      scrollable: flag('scrollable') || undefined,
      checkable: flag('checkable') || undefined,
      checked: flag('checked') || undefined,
      enabled: attrs.enabled === undefined ? undefined : flag('enabled'),
      focused: flag('focused') || undefined,
      selected: flag('selected') || undefined,
      password: flag('password') || undefined,
    };
    if (node.password && node.text) node.text = '••••••••';
    nodes.push(node);
    if (!selfClosing) stack.push(node.index);
  }
  return nodes;
}

function keep(node: PhoneNode): boolean {
  return Boolean(node.text || node.desc || node.clickable || node.scrollable || node.checkable || node.focused || (node.id && !node.id.endsWith(':id/content')));
}

/** Centre of a node's bounds (where a tap lands). */
export function centreOf(bounds: [number, number, number, number]): { x: number; y: number } {
  return { x: Math.round((bounds[0] + bounds[2]) / 2), y: Math.round((bounds[1] + bounds[3]) / 2) };
}

/** Indented outline: `- Button "Send" #send_button (tap) @540,1980 [disabled]`. Wrappers collapse. */
export function renderDump(nodes: PhoneNode[], maxLines = 400): { text: string; count: number; truncated: boolean } {
  const level: number[] = [];
  const kept: boolean[] = [];
  const lines: string[] = [];
  let truncated = false;
  for (const node of nodes) {
    const isKept = keep(node);
    kept[node.index] = isKept;
    const parentLevel = node.parent >= 0 ? level[node.parent] : -1;
    level[node.index] = node.parent < 0 ? 0 : kept[node.parent] ? parentLevel + 1 : parentLevel;
    if (!isKept) continue;
    if (lines.length >= maxLines) { truncated = true; continue; }
    const parts = [`- ${node.cls ?? 'View'}`];
    if (node.text) parts.push(`"${node.text.replace(/\s+/g, ' ').slice(0, 200)}"`);
    if (node.desc && node.desc !== node.text) parts.push(`(${node.desc.replace(/\s+/g, ' ').slice(0, 200)})`);
    if (node.id) parts.push(`#${node.id.replace(/^[\w.]+:id\//, '')}`);
    const actions = [node.clickable ? 'tap' : '', node.scrollable ? 'scroll' : '', node.checkable ? (node.checked ? 'checked' : 'unchecked') : ''].filter(Boolean);
    if (actions.length) parts.push(`(${actions.join(',')})`);
    if (node.bounds) { const c = centreOf(node.bounds); parts.push(`@${c.x},${c.y}`); }
    if (node.enabled === false) parts.push('[disabled]');
    if (node.focused) parts.push('[focused]');
    if (node.selected) parts.push('[selected]');
    lines.push(`${'  '.repeat(Math.max(0, level[node.index]))}${parts.join(' ')}`);
  }
  return { text: lines.join('\n'), count: lines.length, truncated };
}

/** Screen size from the dump's root bounds (the first node usually spans the screen). */
export function screenOf(nodes: PhoneNode[]): { width: number; height: number } | undefined {
  let width = 0;
  let height = 0;
  for (const node of nodes) {
    if (!node.bounds) continue;
    width = Math.max(width, node.bounds[2]);
    height = Math.max(height, node.bounds[3]);
  }
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** Parses `adb devices -l`. */
export function parseDevices(output: string): PhoneDevice[] {
  const devices: PhoneDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('List of devices') || trimmed.startsWith('*')) continue;
    const [serial, state, ...rest] = trimmed.split(/\s+/);
    if (!serial || !state) continue;
    const info: Record<string, string> = {};
    for (const part of rest) {
      const index = part.indexOf(':');
      if (index > 0) info[part.slice(0, index)] = part.slice(index + 1);
    }
    devices.push({ serial, state, model: info.model?.replace(/_/g, ' '), product: info.product, transport: info.transport_id });
  }
  return devices;
}

/** Parses `wm size` ("Physical size: 1080x2400", optional "Override size: …"). */
export function parseWmSize(output: string): { width: number; height: number } | undefined {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(output);
  const match = override ?? physical;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined;
}
