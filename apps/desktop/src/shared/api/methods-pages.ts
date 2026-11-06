// RPC contract part: the views in <data>/pages (runtime/root/pages.ts), custom tabs of the side pane.
// Owns: these shapes. Never: behaviour.

export interface PageInfo {
  /** The file's name without .html or .js. */
  name: string;
  path: string;
  /** The file's time in ms: a new one reloads an open page. */
  updatedAt: number;
}

declare module '../api/methods.ts' {
  interface Methods {
    'pages.list': { params: void; result: PageInfo[] };
    /** The document of a page, as its frame loads it. */
    'pages.read': { params: { name: string }; result: { html: string } };
  }
}

declare module '../api/events.ts' {
  interface EventMap {
    /** A file in <data>/pages changed (topic 'system'). */
    'pages.updated': { pages: PageInfo[] };
  }
}
