// Guards every stylesheet of the UI (src/ui/styles, read from the folder – F08): size limit, an
// Owns/Never header, balanced blocks, at least one rule, colors only through tokens (tokens.css
// defines them), every var() defined, light/dark token parity, the index imports them all, and
// the shell frame rules stay scoped (blocks/AppFrame.tsx reuses the class `app-frame`).
// Owns: static checks of the CSS text. Never: renders anything or judges the look.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/styles');
/** Every stylesheet in the folder; the area files are all but the index and the token sheet. */
const ALL_FILES = readdirSync(STYLES).filter((name) => name.endsWith('.css')).sort();
const AREA_FILES = ALL_FILES.filter((name) => name !== 'index.css' && name !== 'tokens.css');
/** Custom properties set inline by components (style={{ '--x': … }}), not by tokens.css. */
const INLINE_VARS = new Set(['--sidebar-width', '--pane-width', '--icon', '--depth', '--tab-width']);
/** Literal colors left in area files, whole rules (open point for the CSS owner: a token for them). B-044 visual
 *  pass: the filled danger button got its tokens (--danger-fill, --danger-fill-fg), none is left. */
const KNOWN_LITERALS: Record<string, string[]> = {};

const read = (name: string): string => readFileSync(path.join(STYLES, name), 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Custom properties declared inside the first block that follows `marker`. */
function blockVars(css: string, marker: string): Set<string> {
  const start = css.indexOf(marker);
  assert.ok(start >= 0, `marker not found: ${marker}`);
  let depth = 0;
  let begin = -1;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') { depth++; if (begin < 0) begin = i; }
    if (css[i] === '}') { depth--; if (depth === 0) return new Set([...css.slice(begin, i).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1])); }
  }
  throw new Error(`unclosed block after ${marker}`);
}

test('every stylesheet stays small, starts with an owner header, has rules and balanced blocks', () => {
  assert.ok(ALL_FILES.length >= 16 && ALL_FILES.includes('tokens.css') && ALL_FILES.includes('chat.css'), `found only ${ALL_FILES.join(', ')}`);
  for (const name of ALL_FILES) {
    const css = read(name);
    assert.ok(css.split('\n').length < 450, `${name} exceeds 450 lines`);
    assert.match(css.trimStart(), /^\/\*[^]*?Owns:[^]*?Never:[^]*?\*\//, `${name} needs an Owns/Never header`);
    const text = stripComments(css);
    assert.ok(text.trim(), `${name} has no rule outside comments`);
    let depth = 0;
    for (const char of text) {
      if (char === '{') depth++;
      if (char === '}') depth--;
      assert.ok(depth >= 0, `${name}: closing brace without opening`);
    }
    assert.equal(depth, 0, `${name}: unclosed block`);
    assert.equal((text.match(/\(/g) ?? []).length, (text.match(/\)/g) ?? []).length, `${name}: unbalanced parentheses`);
  }
});

test('colors come only from tokens (no literal colors or gradients in area files)', () => {
  for (const name of AREA_FILES) {
    const text = (KNOWN_LITERALS[name] ?? []).reduce((css, rule) => css.replace(rule, ''), stripComments(read(name)));
    assert.doesNotMatch(text, /#[0-9a-f]{3,8}\b/i, `${name} has a hex color`);
    assert.doesNotMatch(text, /\b(?:rgba?|hsla?|hwb|lab|lch|oklch)\(/i, `${name} has a color function`);
    assert.doesNotMatch(text, /gradient\(/i, `${name} has a gradient`);
    assert.doesNotMatch(text, /:\s*(?:white|black|red|green|blue|gray|grey|orange)\b/i, `${name} has a named color`);
  }
});

test('every var() used by the stylesheets is defined', () => {
  const defined = new Set<string>(INLINE_VARS);
  for (const name of ALL_FILES) {
    for (const match of stripComments(read(name)).matchAll(/(--[\w-]+)\s*:/g)) defined.add(match[1]);
  }
  for (const name of ALL_FILES) {
    for (const match of stripComments(read(name)).matchAll(/var\((--[\w-]+)/g)) {
      assert.ok(defined.has(match[1]), `${name} uses undefined ${match[1]}`);
    }
  }
});

test('dark tokens are the same set for the explicit and the system dark theme', () => {
  const tokens = stripComments(read('tokens.css'));
  const explicit = blockVars(tokens, ':root[data-theme=dark]');
  const system = blockVars(tokens, ':root[data-theme=system]');
  assert.deepEqual([...explicit].sort(), [...system].sort());
  const light = blockVars(tokens, ':root {');
  for (const name of explicit) assert.ok(light.has(name), `${name} has a dark value but no light value`);
  for (const name of ['--badge-bg', '--badge-fg', '--qr-bg', '--shadow-raised', '--shadow-sheet']) {
    assert.ok(light.has(name) && explicit.has(name), `${name} must exist in light and dark`);
  }
});

test('the stylesheet index imports every other stylesheet once, tokens first', () => {
  const imports = [...stripComments(read('index.css')).matchAll(/@import "\.\/([\w-]+\.css)";/g)].map((match) => match[1]);
  assert.deepEqual([...imports].sort(), ALL_FILES.filter((name) => name !== 'index.css'));
  assert.equal(new Set(imports).size, imports.length, 'a stylesheet is imported twice');
  assert.deepEqual(imports.slice(0, 2), ['tokens.css', 'base.css']);
});

test('compact desktop windows keep caption controls beside the draggable top row on every OS', () => {
  // The frame's row or the pushed screen's own row makes room at either edge. Nothing above it,
  // and no second title row, spends height on the native controls (including macOS traffic lights).
  const css = stripComments(read('mobile.css'));
  const top = '.mobile-shell > .mobile-top, .mobile-shell.own-header > .mobile-main > * > .frame-header';
  assert.ok(css.replace(/\s+/g, ' ').includes(top), 'both frame and pushed-screen headers share the caption rule');
  assert.match(css, /--caption-space:\s*var\(--caption-reserve\)/, 'the top row reserves the right edge');
  assert.match(css, /--caption-start-space:\s*var\(--caption-left\)/, 'the top row reserves the left edge');
  const row = stripComments(read('header.css')).match(/\.frame-header\s*\{([^}]*)\}/);
  assert.ok(row, 'the header row');
  assert.match(row[1], /height:\s*var\(--header-h\)/, 'one row of the overlay height (main/title-bar.ts)');
  assert.match(row[1], /(?:^|;)\s*app-region:\s*drag/, 'the window moves by its top row');
  assert.match(css, /:root\[data-platform=desktop\] \.mobile-shell :is\(button, a, input, select, textarea[^)]*\)\s*\{[^}]*app-region:\s*no-drag/, 'controls in the row stay clickable');
  assert.doesNotMatch(css, /\.mobile-shell::before|--stack-top|--windowbar-h/, 'no extra caption strip or offset');
  assert.doesNotMatch(css, /grid-template-rows:\s*var\(--header-h\)\s+var\(--header-h\)|height:\s*calc\(2\s*\*\s*var\(--header-h\)\)/, 'narrow pushed screens keep one header row');
  const narrow = css.match(/@media \(max-width: 519px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(narrow, 'narrow desktop windows use compact cells');
  assert.match(narrow[1], /grid-auto-columns:\s*32px/, 'fixed smaller cells leave room beside the caption controls');
  assert.doesNotMatch(css, /:has\(> :is\(\.voice-pill|\.mobile-update/,'no docked pills or update strip deciding which element is the top row');
  const palette = css.match(/:root\[data-platform=desktop\] body:has\(\.mobile-shell\) dialog\.dialog\.palette\s*\{([^}]*)\}/);
  assert.ok(palette, 'the palette stays below the native controls on every desktop OS');
  assert.match(palette[1], /margin-top:\s*var\(--header-h\)/);
  // the status line lies over the body's top under the top row: it reserves no line and never pushes the body
  assert.match(css, /\.mobile-shell > \.status-host\s*\{[^}]*top:\s*calc\(/);
  assert.doesNotMatch(css, /--notice-h/, 'no reserved notice line in the stack');
});

test('the chat panel overlays exactly when the chat view has no room for the chat + the panel minimum', () => {
  const shell = stripComments(read('shell.css'));
  const minChat = Number(shell.match(/--sidebar-size:[^;]*100% - (\d+)px/)?.[1]);
  const paneMin = Number(shell.match(/--pane-size:\s*clamp\((\d+)px/)?.[1]);
  // B-044 decision 3: opening the panel never narrows the sidebar (that would move the chat title)
  assert.doesNotMatch(shell, /--panel-reserve/);
  const chat = stripComments(read('chat.css'));
  const threshold = Number(chat.match(/@container chat-view \(max-width: (\d+)px\)\s*\{\s*\.chat-panel/)?.[1]);
  assert.ok(paneMin > 0 && minChat > 0, 'pane minimum or chat reserve not found');
  assert.equal(threshold, paneMin + minChat - 1);
  // beside the chat it is the workspace pane's width (one right-pane width) and leaves the chat its minimum
  assert.ok(chat.includes(`width: clamp(${paneMin}px, var(--pane-size, var(--panel-w)), 100cqi - ${minChat}px)`), 'the panel takes the pane width and leaves the chat its minimum');
});

test('one centred chat column: the text column and the composer share one axis and one width', () => {
  const chat = stripComments(read('chat.css'));
  const composer = stripComments(read('composer.css'));
  assert.ok(stripComments(read('shell.css')).includes('.shell > .app-frame { --pane-size:'), 'every right pane has one width, open or not');
  // B-078: no virtual width (pane reserve added back) and no left-edge maths any more
  assert.doesNotMatch(chat + composer, /--chat-view-w|--col-left|--col-w\b|@property/);
  // both size against the chat column (100cqi) and centre with auto margins
  assert.match(chat, /\.message-column, \.composer-area \{[^}]*width: min\(var\(--message-max\), 100cqi - 2 \* var\(--col-inset\)\);\s*margin-inline: auto/);
  assert.match(chat, /--col-inset: clamp\(16px, 5cqi, 24px\)/);
  // a gutter on both edges: the scroller's middle is the column's middle
  assert.match(chat, /\.message-scroller \{[^}]*scrollbar-gutter: stable both-edges/);
  assert.doesNotMatch(composer, /\.composer-area \{[^}]*margin: 0 0 18px var/);
  // no layout switch keyed on the column's own width (the inset scales without a step)
  assert.doesNotMatch(chat + composer, /@container chat-column/);
});

test('shell frame rules are scoped so the mini-app root (.app-frame) is not restyled', () => {
  const text = stripComments(read('shell.css'));
  for (const match of text.matchAll(/([^{}]*)\{/g)) {
    for (const selector of match[1].split(',')) {
      if (/\.app-frame(?![\w-])/.test(selector)) assert.match(selector.trim(), /^\.shell > \.app-frame/, `unscoped: ${selector.trim()}`);
    }
  }
});
