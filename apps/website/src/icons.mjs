// Owns: the site's line icons (24px grid, 1.5 stroke, drawn for this site) and icon(name).
// Never: brand marks (brand.mjs) or page content.
const P = {
  team: '<circle cx="12" cy="5.8" r="2.5"/><rect x="2.8" y="14.5" width="5" height="5" rx="1"/><rect x="9.5" y="14.5" width="5" height="5" rx="1"/><rect x="16.2" y="14.5" width="5" height="5" rx="1"/><path d="M12 8.3v3.2M5.3 14.5v-3h13.4v3M12 11.5v3"/>',
  flow: '<rect x="3" y="4" width="6" height="6" rx="1"/><rect x="15" y="14" width="6" height="6" rx="1"/><path d="M9 7h4a2 2 0 0 1 2 2v5"/><path d="m13 12 2 2 2-2"/>',
  import: '<path d="M12 3v11"/><path d="m7.5 9.5 4.5 4.5 4.5-4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  people: '<circle cx="8" cy="8" r="3"/><rect x="14" y="5" width="6" height="6" rx="1.2"/><path d="M3 19a5 5 0 0 1 10 0"/><path d="M13.5 19a3.5 3.5 0 0 1 7 0"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  rooms: '<path d="M3 5h11v8H7l-4 3z"/><path d="M14 9h7v8l-3-2h-6v-2"/>',
  inbox: '<path d="M3 13l2.5-8h13L21 13v6H3z"/><path d="M3 13h5l1.5 2.5h5L16 13h5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  home: '<path d="M4 11 12 4l8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  widget: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="3.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><path d="M17 13.5v7M13.5 17h7"/>',
  wake: '<circle cx="12" cy="13" r="7"/><path d="M12 9.5V13l2.5 1.5M4 5.5 6.5 3M20 5.5 17.5 3"/>',
  tray: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 13h18M8 21h8M12 17v4"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/>',
  loop: '<path d="M17 7H8a4 4 0 0 0 0 8h1"/><path d="M7 17h9a4 4 0 0 0 0-8h-1"/><path d="m14 4 3 3-3 3"/><path d="m10 20-3-3 3-3"/>',
  plan: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 14.5h4"/>',
  route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6a3.5 3.5 0 0 0 0-7h-4a3.5 3.5 0 0 1 0-7h6"/>',
  gauge: '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="m12 13 4-4"/><circle cx="12" cy="13" r="1.2"/>',
  switch: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  lean: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  api: '<circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="m11 12.5 6 2.2-2.6 1-1 2.6z"/>',
  send: '<path d="M21 3 3 10.5l7 2.5 2.5 7z"/><path d="M10 13 21 3"/>',
  code: '<path d="M8 7 3 12l5 5M16 7l5 5-5 5"/>',
  book: '<path d="M4 4.5h6a2 2 0 0 1 2 2V20a2 2 0 0 0-2-2H4z"/><path d="M20 4.5h-6a2 2 0 0 0-2 2V20a2 2 0 0 1 2-2h6z"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
  brain: '<path d="M12 4.5a3.5 3.5 0 0 0-6.5 1.8A3.5 3.5 0 0 0 4 12.5a3.5 3.5 0 0 0 3 5.3A2.8 2.8 0 0 0 12 19.5z"/><path d="M12 4.5a3.5 3.5 0 0 1 6.5 1.8 3.5 3.5 0 0 1 1.5 6.2 3.5 3.5 0 0 1-3 5.3 2.8 2.8 0 0 1-5 1.7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  wave: '<path d="M3 12h1.5M7 8.5v7M11 5v14M15 8v8M19 10v4"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  devices: '<rect x="2.5" y="5" width="13" height="10" rx="1.5"/><path d="M6 19h6M9 15v4"/><rect x="17" y="9" width="4.5" height="10" rx="1.2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.5 3.2 8 7.5 9.5 4.3-1.5 7.5-5 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  coin: '<circle cx="12" cy="12" r="8.5"/><path d="M14.8 8.8a3.6 3.6 0 1 0 0 6.4M7.8 11h5M7.8 13.2h5"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  stop: '<rect x="4" y="4" width="16" height="16" rx="3"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16.5 6.5 19 9M14 9l2 2"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1 1 2-2M3.5 12l1 1 2-2M3.5 18l1 1 2-2"/>',
  pc: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/>',
  wand: '<path d="m4 20 11-11"/><path d="m13.5 7.5 3 3M15 3.5v2M20.5 9h-2M18.5 5.5l1.5-1.5M19 14l1 1M9.5 4l.8 1.2"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4.5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4.5L20 16"/><path d="M20 20v-4h-4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  external: '<path d="M8 16 16 8M9 8h7v7"/>',
  windows: '<path d="M3.5 5.5 10.5 4.5v7h-7zM12 4.3l8.5-1.2v8.4H12zM3.5 13h7v6.6l-7-1zM12 13h8.5v8l-8.5-1.2z" fill="currentColor" stroke="none"/>',
  apple: '<path d="M16.4 12.6c0-2.2 1.8-3.2 1.9-3.3-1-1.5-2.6-1.7-3.2-1.7-1.4-.1-2.6.8-3.3.8-.7 0-1.7-.8-2.8-.8-1.5 0-2.8.9-3.6 2.2-1.5 2.6-.4 6.5 1.1 8.6.7 1 1.6 2.2 2.7 2.2 1.1 0 1.5-.7 2.8-.7s1.7.7 2.8.7c1.2 0 1.9-1 2.6-2.1.8-1.2 1.2-2.4 1.2-2.4s-2.2-.9-2.2-3.5zM14.3 6.1c.6-.7 1-1.7.9-2.7-.9 0-1.9.6-2.5 1.3-.6.6-1 1.6-.9 2.6 1 .1 1.9-.5 2.5-1.2z" fill="currentColor" stroke="none"/>',
  linux: '<path d="M12 3c-2 0-3.2 1.7-3.2 4 0 1.4.3 2.3-.6 3.6C7 12.3 6 14 6 16c0 .7.2 1.3.5 1.8L5 19.5c-.4.5 0 1.2.6 1.2h3c.8 0 1.4-.4 1.8-.9.5.1 1 .2 1.6.2s1.1-.1 1.6-.2c.4.5 1 .9 1.8.9h3c.6 0 1-.7.6-1.2l-1.5-1.7c.3-.5.5-1.1.5-1.8 0-2-1-3.7-2.2-5.4-.9-1.3-.6-2.2-.6-3.6 0-2.3-1.2-4-3.2-4z"/><circle cx="10.6" cy="7" r=".6" fill="currentColor"/><circle cx="13.4" cy="7" r=".6" fill="currentColor"/>',
  android: '<path d="M5 17.5V12a7 7 0 0 1 14 0v5.5z"/><path d="m7.2 6.2-1.7-2.4M16.8 6.2l1.7-2.4"/><circle cx="9.3" cy="12" r=".9" fill="currentColor" stroke="none"/><circle cx="14.7" cy="12" r=".9" fill="currentColor" stroke="none"/><path d="M5 20.5h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  hash: '<path d="M9 4 7 20M17 4l-2 16M4 9h16M3.5 15h16"/>',
  github: '<path d="M12 2.8a9.2 9.2 0 0 0-2.9 17.9c.5.1.6-.2.6-.4v-1.6c-2.6.6-3.1-1.1-3.1-1.1-.4-1.1-1-1.4-1-1.4-.8-.6.1-.6.1-.6.9.1 1.4 1 1.4 1 .8 1.4 2.2 1 2.7.8.1-.6.3-1 .6-1.2-2-.2-4.2-1-4.2-4.5 0-1 .4-1.8.9-2.5-.1-.2-.4-1.2.1-2.4 0 0 .8-.2 2.5.9a8.6 8.6 0 0 1 4.6 0c1.8-1.2 2.5-.9 2.5-.9.5 1.3.2 2.2.1 2.4.6.7.9 1.5.9 2.5 0 3.5-2.2 4.3-4.2 4.5.3.3.6.8.6 1.7v2.5c0 .2.2.5.6.4A9.2 9.2 0 0 0 12 2.8z" fill="currentColor" stroke="none"/>',
};

export function icon(name, cls = '') {
  const body = P[name] || P.spark;
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

// The Autark mark: an A without its crossbar (Λ) and a dot where the bar would be.
// The dot is the agent that starts on its own.
export const MARK_PATH = 'M12 50 28.5 12h7L52 50h-7.5L32 20.5 19.5 50Z';
export const MARK_DOT = { cx: 32, cy: 39.5, r: 4.3 };

export function mark(cls = '', { dot = 'var(--signal)', ink = 'currentColor', title } = {}) {
  const t = title ? `<title>${title}</title>` : '';
  const aria = title ? 'role="img"' : 'aria-hidden="true" focusable="false"';
  return `<svg class="mark ${cls}" viewBox="0 0 64 64" ${aria}>${t}<path d="${MARK_PATH}" fill="${ink}"/><circle class="mark__dot" cx="${MARK_DOT.cx}" cy="${MARK_DOT.cy}" r="${MARK_DOT.r}" fill="${dot}"/></svg>`;
}
