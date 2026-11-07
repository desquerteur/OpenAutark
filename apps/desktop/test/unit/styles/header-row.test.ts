// The desktop header row and the content sheet (23.10 design, B-044 frame): every zone's header row
// (lib/header.tsx, header.css) shares the chrome color and one height, zones clip and only their
// bodies scroll, the caption controls' room is assigned once to the rightmost zone (no :has()
// juggling), the main zone's workspace cell sits in that room, no column or panel keeps its own
// rounded corner (that left a wedge against the window edge or the neighbour), the sheet's edge is
// drawn once by the frame, the caption reserve follows the measured window-controls overlay, a chat's area
// opens below the chat header row in one fixed height, in the chat's own look, the global pane's tab strip is the title
// row's part above the pane only where the row leaves it room for three titled tabs (else, and in a narrow window, it is
// the pane's first line below the row), and a narrow tab keeps its × cell and its icon's place.
// Owns: static checks of header/shell/chat/chat-area/tasks/base CSS text. Never: renders (test/ui/shell-columns-window
// and test/ui/stability-window do).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/styles');
const css = (name: string): string => readFileSync(path.join(STYLES, name), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level parts of a selector list (commas inside :is(…) stay). */
function selectors(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; } else current += char;
  }
  return [...parts, current.trim()];
}

/** The text inside the first `@media <query> { … }` block. */
function media(text: string, query: string): string {
  const start = text.indexOf(`@media ${query} {`);
  assert.ok(start >= 0, `no @media ${query}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(text.indexOf('{', start) + 1, i);
  }
  return '';
}

/** Declarations of every top-level rule whose selector list contains `selector`, in order. */
function rule(text: string, selector: string): string {
  const found = [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => selectors(match[1]).includes(selector)).map((match) => match[2]);
  assert.ok(found.length, `no rule for ${selector}`);
  return found.join(';');
}

test('the top headers form one row in the chrome color, without own bottom borders', () => {
  const row = rule(css('header.css'), '.frame-header');
  assert.match(row, /height:\s*var\(--header-h\)/);
  assert.match(row, /flex:\s*none/, 'a header never shrinks in a column whose content overflows (a long chat shrank it to 36 px)');
  assert.match(row, /--header-bg:\s*var\(--chrome\)/);
  assert.match(row, /background:\s*var\(--header-bg\)/);
  assert.doesNotMatch(row, /border/, 'the sheet\'s edge line takes the row\'s bottom pixel');
  assert.match(row, /grid-template-columns:[^;]*var\(--caption-space, 0px\)/, 'the caption track');
  assert.match(row, /(?:padding-left|padding):[^;]*calc\(12px \+ var\(--caption-start-space, 0px\)\)/, 'left-side controls reduce header width instead of pushing it down');
  const shell = css('shell.css');
  assert.match(rule(shell, '.sidebar'), /background:\s*var\(--chrome\)/);
  assert.match(rule(shell, '.shell > .app-frame'), /background:\s*var\(--chrome\)/);
  assert.doesNotMatch(shell, /\[data-os=mac\][^{]*\.app\s*\{[^}]*padding-top/, 'no platform-specific band above the header');
  assert.match(rule(shell, '.rail-header'), /transform:\s*translateX\(var\(--caption-left\)\)/, 'the sidebar toggle also clears left-side controls');
});

test('zones clip and only their bodies scroll; the side body keeps its scrollbar\'s room', () => {
  const shell = css('shell.css');
  for (const zone of ['.sidebar', '.main-slot', '.global-pane']) assert.match(rule(shell, zone), /overflow:\s*clip/, `${zone} clips`);
  const body = rule(shell, '.sidebar-body');
  assert.match(body, /overflow:\s*hidden auto/);
  assert.match(body, /scrollbar-gutter:\s*stable/);
  assert.doesNotMatch(shell, /sidebar-heading|sidebar-search|shell-activity|connection-line|main-controls/, 'the old heading, search row, pill corner, connection line and controls are gone');
  // the sidebar search's compact rule lost to `input[type=text].input` (the 16 px sideways shift)
  assert.doesNotMatch(css('base.css'), /input\[type=text\]\.input/, 'one class, so an area rule wins again');
});

test('the caption controls\' room is assigned once to the rightmost zone; the workspace cell sits in it at one place', () => {
  const shell = css('shell.css');
  assert.match(rule(shell, '.app'), /--native-caption-space:\s*var\(--caption-reserve\)/);
  // The feedback cell right before the caption controls, the workspace cell left of it; their room reserved once here too
  assert.match(rule(shell, '.shell > .app-frame > .rightmost'), /--zone-room:\s*calc\(var\(--native-caption-space, 0px\) \+ var\(--workspace-cell\) \+ var\(--feedback-cell\)\)/);
  assert.match(rule(shell, '.shell > .app-frame > .frame-feedback-cell'), /right:\s*calc\(12px \+ var\(--native-caption-space, 0px\)\)/, 'the header grid\'s 12 px inset, left of the caption controls');
  for (const zone of ['.main-slot', '.global-pane']) {
    const declarations = rule(shell, zone);
    assert.match(declarations, /--zone-room:\s*0px/, `${zone} reserves nothing unless rightmost`);
    assert.match(declarations, /--caption-space:\s*var\(--zone-room\)/);
  }
  const cell = rule(shell, '.shell > .app-frame > .frame-workspace-cell');
  assert.match(cell, /position:\s*absolute/, 'one element of the frame, whatever zone is rightmost');
  assert.match(cell, /right:\s*calc\(12px \+ var\(--native-caption-space, 0px\) \+ var\(--feedback-cell\)\)/, 'right beside the feedback cell');
  for (const match of shell.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    assert.ok(!(/:has\(/.test(match[1]) && /caption/.test(match[2])), `no :has() decides the caption room: ${match[1].trim()}`);
  }
  assert.doesNotMatch(shell, /with-pane[^{]*\{[^}]*caption/, 'the open pane changes no caption rule');
});

test('the open workspace pane moves no header cell: the main zone keeps its width and its row runs on over the pane', () => {
  const shell = css('shell.css');
  // no grid column for the pane: the main zone is as wide with the pane open as closed
  assert.doesNotMatch(shell, /with-pane[^{]*\{[^}]*grid-template-columns/, 'the pane is no grid column');
  assert.match(rule(shell, '.main-slot'), /padding-right:\s*var\(--pane-reserve, 0px\)/, 'the body leaves the pane its room');
  for (const header of ['.main-slot > .frame-header', '.main-slot > * > .frame-header.zone-main']) {
    assert.match(rule(shell, header), /margin-right:\s*calc\(-1 \* var\(--pane-reserve, 0px\)\)/, `${header}: the header row reaches over it`);
  }
  const pane = rule(shell, '.global-pane');
  assert.match(pane, /position:\s*absolute/);
  assert.match(pane, /width:\s*var\(--pane-size\)/);
  // one length for the pane and the reserve: viewport units, never a percentage that resolves per box
  assert.doesNotMatch(rule(shell, '.shell > .app-frame.with-pane'), /--pane-size:[^;]*%/);
});

test('a busy button keeps its box: transparent label under a centred spinner, never visibility', () => {
  const base = css('base.css');
  assert.match(rule(base, '.button[aria-busy=true]'), /color:\s*transparent/);
  const spin = rule(base, '.button-spin');
  assert.match(spin, /position:\s*absolute/);
  assert.match(spin, /inset:\s*0/);
  assert.doesNotMatch(base, /visibility/);
});

test('no column or side panel rounds its own corner; the frame draws the sheet edge once', () => {
  for (const [file, selector] of [['shell.css', '.main-slot'], ['shell.css', '.global-pane'], ['chat.css', '.chat-panel'], ['tasks.css', '.tasks-detail']]) {
    assert.doesNotMatch(rule(css(file), selector), /radius/, `${selector} keeps no rounded corner`);
  }
  const shell = css('shell.css');
  const edge = rule(shell, '.shell > .app-frame::after');
  assert.match(edge, /top:\s*var\(--header-h\)/);
  assert.match(edge, /border-top-left-radius:\s*var\(--r-sheet\)/);
  const cover = rule(shell, '.shell > .app-frame::before');
  assert.match(cover, /solid var\(--chrome\)/);
  assert.match(cover, /clip-path:\s*inset\(var\(--cover\) 0 0 var\(--cover\)\)/);
  assert.match(rule(shell, '.shell > .app-frame.sidebar-closed'), /--sheet-left:\s*0px/, 'without sidebar the sheet starts after the rail');
  // no reserved notice line under the header row: the status line lies over the zone
  assert.doesNotMatch(shell, /--notice-h/, 'no reserved line under the header row');
  assert.match(rule(css('header.css'), '.status-host'), /position:\s*absolute/, 'the status line overlays, it reserves nothing');
  // the browser pane lies below the row and its divider starts at its own top; where its strip is the row's part above
  // it, the divider starts under the row
  assert.match(rule(shell, '.global-pane::before'), /top:\s*0;/);
  assert.match(rule(shell, '.shell > .app-frame.strip-in-row > .global-pane::before'), /top:\s*var\(--header-h\)/);
  // B-044 decision 3: the chat side panel and the task detail are content below the header row, so
  // their dividers start at their own top (= the row's bottom edge).
  assert.match(rule(css('chat.css'), '.chat-panel:not(.sheet)::before'), /top:\s*0[;\s]/);
  assert.match(rule(css('tasks.css'), '.tasks-detail::before'), /top:\s*0[;\s]/);
});

test('a chat\'s area opens below the chat header row in one fixed height, attached to the chat; the global pane keeps its Chrome look', () => {
  const sheet = css('chat-area.css');
  const area = rule(sheet, '.chat-area');
  assert.match(area, /flex:\s*none/, 'it never grows or shrinks with what it shows');
  // AF-010: the saved height (appearance.chatDock.height, set inline by ChatArea.tsx), before it is known a share
  assert.match(area, /height:\s*clamp\(\d+px,\s*var\(--chat-dock-h,\s*\d+%\),\s*100% - \d+px\)/, 'a share of the chat column that leaves the messages and the composer their room');
  assert.doesNotMatch(area, /radius/, 'no corner of its own');
  assert.match(area, /border-bottom:\s*1px solid var\(--line\)/, 'one line to the messages');
  assert.doesNotMatch(area, /border-left|::before/, 'no divider at its side'); // AF-010: docked right or left it has one (.dock-right, .dock-left)
  assert.match(rule(sheet, '.chat-area.dock-right'), /border-left:\s*1px solid var\(--line\)/, 'docked right: one line to the messages');
  assert.match(rule(sheet, '.chat-column.area-full > .chat-area'), /height:\s*auto/, 'full view: the column above the composer');
  assert.match(rule(sheet, '.chat-area .browser-strip'), /background:\s*var\(--surface\)/, 'the chat\'s colour');
  assert.match(rule(css('workspace-browser.css'), '.browser-strip'), /background:\s*var\(--chrome\)/, 'the global pane\'s strip stays chrome-coloured');
  assert.match(rule(css('mobile.css'), '.mobile-shell .chat-area'), /flex:\s*1 1 auto/, 'the phone: the chat body above the composer');
});

test("where the row has room, the global pane's tab strip is the title row above the pane, clear of the caption and the frame's cells", () => {
  const shell = css('shell.css');
  const pane = rule(shell, '.global-pane');
  assert.match(pane, /z-index:\s*9;[^]*top:\s*var\(--header-h\);/, 'the pane lies below the row, under the status line, as before B-072');
  const inRow = rule(shell, '.shell > .app-frame.strip-in-row > .global-pane');
  assert.match(inRow, /top:\s*0/, 'with room in the row it starts at the window\'s top');
  assert.match(inRow, /z-index:\s*12/, 'over the sheet\'s edge (11)…');
  for (const cell of ['.frame-workspace-cell', '.frame-feedback-cell']) assert.match(rule(shell, `.shell > .app-frame > ${cell}`), /z-index:\s*13/, `…under the frame's ${cell}`);
  assert.match(rule(shell, '.shell > .app-frame::after'), /top:\s*var\(--header-h\)/);
  assert.match(shell, /::before, \.shell > \.app-frame::after \{[^}]*z-index:\s*11/);
  // the room: the strip's tab room in the row at the pane's width beside the open sidebar (its toggle moves no strip),
  // less the caption controls and the frame's cells; none in a narrow window; Shell.tsx compares it with ROW_ROOM
  const room = rule(shell, '.shell > .app-frame > .pane-row-room');
  assert.match(room, /width:\s*max\(0px, clamp\(280px, var\(--pane-width, 400px\), min\(800px, 100vw - var\(--rail-w\) - 540px\)\) - 19px - var\(--native-caption-space, 0px\) - var\(--workspace-cell\) - var\(--feedback-cell\)\)/);
  assert.match(media(shell, '(max-width: 875px)'), /\.shell > \.app-frame > \.pane-row-room\s*\{\s*width:\s*0;/);
  const ui = path.resolve(STYLES, '..');
  const frame = readFileSync(path.join(ui, 'shell', 'Shell.tsx'), 'utf8');
  assert.match(frame, /getBoundingClientRect\(\)\.width >= ROW_ROOM/, 'three titled tabs fit (strip-slots.ts)');
  assert.match(frame, /strip-in-row/);
  assert.match(readFileSync(path.join(ui, 'workspace', 'strip-slots.ts'), 'utf8'), /export const ROW_ROOM = 3 \* TITLED_TAB \+ 3 \* 2 \+ NEW_TAB_CELL;/);
  const browser = css('workspace-browser.css');
  for (const text of [browser, css('header.css'), shell]) assert.doesNotMatch(text, /@media \(width > 875px\)/, 'the class decides, not the window width alone');
  const strip = rule(browser, '.app-frame.strip-in-row .global-pane .browser-strip');
  assert.match(strip, /height:\s*calc\(var\(--header-h\) \+ 1px\)/, 'the row\'s height and the sheet\'s edge line at its foot');
  assert.match(strip, /padding-right:\s*calc\(12px \+ var\(--native-caption-space, 0px\) \+ var\(--workspace-cell\) \+ var\(--feedback-cell\)\)/, 'the caption controls and the frame\'s cells stay free');
  assert.match(strip, /(?:^|[;\s])app-region:\s*drag/, 'its empty room moves the window');
  assert.match(rule(browser, '.browser-strip'), /app-region:\s*no-drag/, 'a strip below the row does not');
  assert.match(css('shell.css'), /\.app :is\([^)]*\[role=tablist\][^)]*\)\s*\{[^}]*app-region:\s*no-drag/, 'tabs and "+" stay clickable in the row');
  assert.match(rule(shell, '.shell > .app-frame.strip-in-row.pane-full > .global-pane .browser-strip'), /width:\s*calc\(var\(--pane-size\) - 1px\)/, 'full view: the strip keeps its box at the right (the pane less its 1 px border)');
  // a main view's row ends before the strip: the chat's title track gives way, another row's caption track takes the pane's place
  const header = css('header.css');
  assert.match(rule(header, '.app-frame.strip-in-row > .main-slot .frame-header.zone-main.has-segments'), /min\(var\(--title-track, 320px\), 100% - var\(--pane-size, 0px\) - 64px\)/);
  for (const selector of ['.app-frame.strip-in-row > .main-slot .frame-header.zone-main:not(.has-segments)', '.app-frame.strip-in-row > .main-slot .frame-header.zone-main.has-lead:not(.has-segments)']) {
    assert.match(rule(header, selector), /minmax\(0, 1fr\) auto max\(var\(--caption-space, 0px\), var\(--pane-size, 0px\)\);/, `${selector}: a long title ends in an ellipsis before the strip`);
  }
  assert.doesNotMatch(browser, /browser-tabs-button|browser-tabs-count/, 'no count cell: All tabs is in the menu');
  assert.doesNotMatch(css('workspace.css') + css('tour.css'), /rotate\(180deg\)/, 'the pane cell\'s icon stands upright');
});

test('a narrow tab keeps its × cell and its icon at one x in every state', () => {
  const browser = css('workspace-browser.css');
  const narrow = /@container strip-tab \(width < 72px\) \{([^]*?)\n\}/.exec(browser)?.[1] ?? '';
  assert.match(narrow, /\.browser-strip-title\s*\{\s*display:\s*none;/, 'its icon only');
  assert.doesNotMatch(narrow, /browser-strip-close|justify-content/, 'no × that comes with the selection, no re-centred icon');
  assert.match(narrow, /\.browser-strip-choose\s*\{\s*padding:\s*0 0 0 4px;/);
  assert.match(narrow, /\.browser-strip-sound\s*\{\s*left:\s*2px;/, 'the speaker centred over the 16 px icon at 4 px, as at 6/8 px in a wide tab');
  assert.match(rule(browser, '.browser-strip-sound'), /left:\s*6px/);
  assert.match(rule(browser, '.browser-strip-choose'), /padding:\s*0 2px 0 8px/);
});

test('caption space follows either edge of the measured overlay; ordinary browser pages reserve nothing', () => {
  const tokens = css('tokens.css');
  const defaults = rule(tokens, ':root');
  assert.match(defaults, /--caption-left:\s*0px/);
  assert.match(defaults, /--caption-reserve:\s*0px/);
  const desktop = rule(tokens, ':root[data-platform=desktop]');
  assert.match(desktop, /--caption-left:\s*env\(titlebar-area-x,/);
  assert.match(desktop, /--caption-reserve:\s*max\(0px,\s*calc\(100vw - var\(--caption-left\) - env\(titlebar-area-width,/);
  const mac = rule(tokens, ':root[data-platform=desktop][data-os=mac]');
  assert.match(mac, /--caption-left-fallback:\s*80px/);
  assert.match(mac, /--caption-right-fallback:\s*0px/);
  assert.doesNotMatch(mac, /--caption-(?:left|reserve):/, 'macOS uses the same geometry with different fallback edges');
});
