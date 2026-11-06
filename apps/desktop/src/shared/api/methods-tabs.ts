// RPC contract part (B-076, "am Handy gut funktioniert"): the side pane of this PC as its phone sees it, and where a
// file, folder or media tab is scrolled to (handlers runtime/rpc/handlers/side-tabs.ts). The phone's pane is its PC's:
// tabs.get reads the spaces of <data>/side-tabs.json – this PC's websites as 'remote' panels with `device` = this PC –
// and tabs.changed brings each change; tabs.set writes what the phone changed (`closed`: the tabs it closed, so a tab
// the PC opened meanwhile stays). A view position is a light value per tab, never in side-tabs.json: tabs.position
// reports it (about every 300 ms while scrolling), tabs.position (event) brings one from this PC's window, its phones
// or a linked PC, tabs.positions lists the last ones.
// Owns: these shapes. Never: behaviour.

import type { SideSpaces } from './workspace-browser.ts';

/** The spaces of a PC's side pane as its phone shows them; `device`: that PC. */
export interface PaneTabs { device: string; spaces: SideSpaces }

/** Where a tab is scrolled to: `fraction` 0..1 of its height, `line` the top line of a text, `time` a video's second. */
export interface TabPosition {
  /** The tab's id as this PC's pane names it. */
  tab: string;
  fraction: number;
  line?: number;
  time?: number;
  /** The window or phone that reported it (it ignores its own echo). */
  from: string;
}

declare module '../api/methods.ts' {
  interface Methods {
    'tabs.get': { params: void; result: PaneTabs };
    'tabs.set': { params: { spaces: SideSpaces; closed?: string[] }; result: { ok: true } };
    'tabs.position': { params: TabPosition; result: { ok: true } };
    'tabs.positions': { params: void; result: TabPosition[] };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** <data>/side-tabs.json changed: the spaces as the phone shows them (topic 'system'; the owner and 'manage' devices). */
    'tabs.changed': PaneTabs;
    /** A tab's view position from this PC's window, a phone or a linked PC (topic 'system'; the owner and 'manage' devices). */
    'tabs.position': TabPosition;
  }
}

export {};
