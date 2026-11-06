// What this PC's computer.* outputs showed: the labels and windows of the element refs
// (computer.ui_tree / act outputs, for the run journal's summaries) and which app each listed
// window belongs to (computer.windows – the resource of a step). Also whether a call's facts are
// this PC's (onThisPc) and a device step's plain description (deviceAction).
// Owns: parsing tree lines into labels, the bounded ref → label table, the window → app map.
// Never: talks to the helper, acts on elements, or treats a label as an instruction.

import type { ActionDescription, ToolContext } from '../tools/types.ts';
import type { WindowInfo } from './service.ts';

/** One tree line: `- button "Bestellen" [ref=e12] #placeOrder …` (see tree.ts nodeLine). */
const REF_LINE = /^\s*-\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?\s+\[ref=([a-z0-9]{1,20})\](?:\s+#(\S+))?/i;

/** "placeOrderButton" / "btn_pay-now" → "place Order Button" / "btn pay now", so ids can be judged by words. */
export function idWords(id: string | undefined): string {
  return (id ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ');
}

/** The words of a label: its name as shown, its `#automationId` split into words. */
export const labelWords = (label: string | undefined) => (label ?? '').replace(/#(\S+)/g, (_match, id: string) => idWords(id));

/** True when the call runs on this PC (facts kept here, like refs or page texts, belong to it). */
export function onThisPc(ctx: ToolContext): boolean {
  try {
    return ctx.deviceId === undefined || ctx.deviceId === ctx.services.devices.self().id;
  } catch {
    return false;
  }
}

/** A device step's description: on this PC it works in `app` when known, else in the PC itself. */
export function deviceAction(summary: string, ctx: ToolContext, reversible = true, app?: string): ActionDescription {
  return { summary, resource: (onThisPc(ctx) ? app : undefined) ?? ctx.deviceId ?? 'this PC', reversible, external: false };
}

/** Which app (process name) each window this PC listed belongs to, and which window is in front. */
export class WindowApps {
  private apps = new Map<number, string>();
  front: number | undefined;

  learn(list: readonly WindowInfo[]): void {
    this.apps = new Map(list.filter((window) => window.process).map((window) => [window.hwnd, window.process.trim().toLowerCase()]));
    this.front = list.find((window) => window.foreground)?.hwnd;
  }

  app(hwnd: number | undefined): string | undefined {
    return hwnd === undefined ? undefined : this.apps.get(hwnd);
  }
}

/** Labels ('button "Bestellen" #placeOrder') of the elements this PC's tree outputs showed, newest kept (bounded like the ref table). */
export class RefLabels {
  private readonly labels = new Map<string, { label: string; hwnd?: number }>();
  private readonly cap: number;

  constructor(cap = 4000) {
    this.cap = cap;
  }

  learn(text: string | undefined, hwnd?: number): void {
    if (!text) return;
    for (const line of text.split('\n')) {
      const match = REF_LINE.exec(line);
      if (!match) continue;
      const [, role, raw, ref, aid] = match;
      const name = raw?.replace(/\\"/g, '"') ?? '';
      this.labels.delete(ref);
      this.labels.set(ref, { label: `${role}${name ? ` "${name}"` : ''}${aid ? ` #${aid}` : ''}`, hwnd });
      if (this.labels.size > this.cap) this.evictOldest();
    }
  }

  get(ref: string): string | undefined {
    return this.entry(ref)?.label;
  }

  /** The window the ref was shown in (undefined when unknown). */
  window(ref: string): number | undefined {
    return this.entry(ref)?.hwnd;
  }

  private entry(ref: string) {
    return this.labels.get(ref.trim().replace(/^\[?ref=/, '').replace(/\]$/, ''));
  }

  private evictOldest(): void {
    this.labels.delete(this.labels.keys().next().value as string);
  }
}
