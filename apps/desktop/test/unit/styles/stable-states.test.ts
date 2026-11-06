// B-044 §2, the owner's standing rule ("Ich mag nicht, dass sich da irgendwas bewegt … Alles bleibt
// 100 Prozent gerade"): selection and toggles change colour, background, border colour or an icon –
// never the box. A CSS lint over the header, nav and view stylesheets (src/ui/styles, all but the
// message content sheets): no rule whose selector carries a state – .selected, .on, .current,
// .active, .pressed, .expanded, [aria-pressed], [aria-expanded], [aria-selected], [aria-current], [aria-checked]
// (a checked menu item, round 2 of the visual pass) or :has(…) –
// sets font-weight, padding, margin, width (min-/max- too) or min-height, because a neighbour would
// move when the state flips; nor does a state class or aria state hide a box (display: none – a narrow tab's × that
// came only with the selection moved its icon). `:has(…)` naming the phone layout (.mobile-shell) is a layout mode, not
// a state. The few deliberate exceptions are listed in ALLOWED, each with why it moves nothing. The
// main views' scroll areas reserve their scrollbar (scrollbar-gutter: stable), so a list that grows
// past the window does not narrow its column.
// Owns: these static checks of the CSS text. Never: renders (test/ui/lib/stable.mjs measures boxes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { splitList, styleRules } from './css-rules.ts';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/styles');
/** Content inside messages (markdown, display blocks): its :has(…) rules describe the content's shape, not a control's state. */
const CONTENT = new Set(['blocks.css', 'widgets.css']);
const FILES = readdirSync(STYLES).filter((name) => name.endsWith('.css') && name !== 'index.css' && name !== 'tokens.css' && !CONTENT.has(name)).sort();

const STATE = /\.(?:selected|on|current|active|pressed|expanded)(?![\w-])|\[aria-(?:pressed|expanded|selected|current|checked)\b|:has\((?![^)]*\.mobile-shell)/;
const SIZE = /^(?:font-weight|padding(?:-[a-z-]+)?|margin(?:-[a-z-]+)?|(?:min-|max-)?width|min-height)$/;

/** Deliberate exceptions: file, a part of the selector, and why nothing moves. */
const ALLOWED: Array<{ file: string; selector: string; why: string }> = [
  { file: 'chat.css', selector: '.message.human .message-content:has(', why: 'the shape of the message content (a display block needs the full bubble width), fixed once the message renders' },
  { file: 'chat.css', selector: '.message:has(.message-author .avatar.working)', why: 'the streaming caret after the last word of a reply being written: it follows the text, no control moves' },
  { file: 'settings.css', selector: '.mode-option.selected .mode-radio::after', why: 'the radio\'s dot inside its fixed 18 px ring (grid-centred), the ring keeps its size' },
  { file: 'mobile.css', selector: '.mobile-shell.pushed .mobile-main:not(:has(> .chat-view))', why: 'the pushed screen\'s kind (a chat brings its own bottom inset), not a state of a control' },
  { file: 'tasks.css', selector: '.task-message:has(> .task-bubble.compact)', why: 'the kind of the task message (D5: a finished approval to-do or agent-made task is one line like a run step), set by its status, not a click: opening the line keeps the gap' },
];

function violations(): string[] {
  const out: string[] = [];
  for (const file of FILES) {
    for (const rule of styleRules(readFileSync(path.join(STYLES, file), 'utf8'))) {
      for (const selector of splitList(rule.selector)) {
        if (!STATE.test(selector)) continue;
        if (ALLOWED.some((entry) => entry.file === file && selector.includes(entry.selector))) continue;
        const sized = rule.declarations.filter((item) => SIZE.test(item.property));
        if (sized.length) out.push(`${file}:${rule.line} ${selector} { ${sized.map((item) => `${item.property}: ${item.value}`).join('; ')} }`);
      }
    }
  }
  return out;
}

test('no state selector changes a box: selection is colour, background or an icon, never weight, padding, margin or size', () => {
  assert.ok(FILES.length > 20, 'the stylesheets were found');
  assert.ok(FILES.includes('header.css') && FILES.includes('chat.css') && FILES.includes('mobile.css'), 'headers, views and the phone layout are checked');
  assert.deepEqual(violations(), [], 'move the size into the base rule (the same in every state) or change only colour/background');
});

/** The state part of STATE without :has(…), which there describes content's shape (an empty label, a model's effort). */
const CLASS_STATE = /\.(?:selected|on|current|active|pressed|expanded)(?![\w-])|\[aria-(?:pressed|expanded|selected|current|checked)\b/;

test('no state class hides a box: what comes and goes with a state keeps its room and changes colour', () => {
  const hidden: string[] = [];
  for (const file of FILES) {
    for (const rule of styleRules(readFileSync(path.join(STYLES, file), 'utf8'))) {
      if (!rule.declarations.some((item) => item.property === 'display' && item.value === 'none')) continue;
      for (const selector of splitList(rule.selector)) if (CLASS_STATE.test(selector)) hidden.push(`${file}:${rule.line} ${selector}`);
    }
  }
  assert.deepEqual(hidden, [], 'keep the box in every state (transparent, as the tabs\' × cells) instead of display: none');
  const sample = styleRules('.a:not(.selected) .b { display: none } .c:has(.d:empty) { display: none } .e.on .f { display: block }');
  assert.deepEqual(sample.flatMap((rule) => splitList(rule.selector).filter((selector) => CLASS_STATE.test(selector) && rule.declarations.some((item) => item.property === 'display' && item.value === 'none'))), ['.a:not(.selected) .b'], 'the check sees what it must refuse');
});

test('every exception names a checked file and says why', () => {
  for (const entry of ALLOWED) {
    assert.ok(entry.why.length > 20, `${entry.file} ${entry.selector}: give the reason`);
    assert.ok(FILES.includes(entry.file), `${entry.file} is checked`);
  }
});

/** The main views' scroll areas (B-044 §2): a scrollbar that comes with more rows must not narrow the column. */
const VIEW_SCROLLERS: Array<{ file: string; selector: string }> = [
  { file: 'chat.css', selector: '.message-scroller' }, { file: 'chat.css', selector: '.chat-panel-body' },
  { file: 'tasks.css', selector: '.tasks-scroll' }, { file: 'tasks.css', selector: '.task-detail-scroll' },
  { file: 'team.css', selector: '.team-scroll, .agent-scroll' },
  { file: 'day.css', selector: '.day-main' }, { file: 'day.css', selector: '.day-cal-scroll' },
  { file: 'settings.css', selector: '.settings-body' }, { file: 'app.css', selector: '.offline-body' },
  { file: 'first-run.css', selector: '.first-run-scroll' }, { file: 'shell.css', selector: '.sidebar-body' },
  { file: 'repair.css', selector: '.repair-view' },
  // visual pass, round 2: a dialog's content (lib/dialog.tsx) – a field never shifts when the form starts to scroll
  { file: 'overlays.css', selector: '.dialog-content' },
];

test('the views\' scroll areas reserve their scrollbar\'s room', () => {
  for (const { file, selector } of VIEW_SCROLLERS) {
    const rule = styleRules(readFileSync(path.join(STYLES, file), 'utf8')).find((entry) => entry.selector === selector);
    assert.ok(rule, `${file}: ${selector}`);
    assert.ok(rule.declarations.some((item) => item.property === 'scrollbar-gutter' && item.value.startsWith('stable')), `${file}: ${selector} has scrollbar-gutter: stable`);
  }
});

/** Declarations of the rule written exactly as `selector` in `file`. */
function declarations(file: string, selector: string): Record<string, string> {
  const rule = styleRules(readFileSync(path.join(STYLES, file), 'utf8')).find((entry) => entry.selector === selector);
  assert.ok(rule, `${file}: ${selector}`);
  return Object.fromEntries(rule.declarations.map((item) => [item.property, item.value]));
}

test("lines and cells that come with a result are reserved: the dialog message, the chat sub line's halves, the composer's model and Ultra cells", () => {
  const message = declarations('base.css', '.dialog-message');
  assert.equal(message.height, '18px', 'one fixed line');
  assert.equal(message['white-space'], 'nowrap');
  // round 2 of the visual pass: in the dialog's footer the line sits beside the buttons (no blank band above them)
  const footerMessage = declarations('overlays.css', '.dialog-footer > .dialog-message');
  assert.equal(footerMessage.flex, '1 1 0');
  // fix round 2: two lines at most – never taller than the buttons beside it (36 px), so the footer keeps its height
  assert.equal(footerMessage['max-height'], '36px');
  assert.equal(footerMessage['-webkit-line-clamp'], '2');
  assert.equal(declarations('base.css', '.button')['min-height'], '36px', 'the buttons the two lines sit beside');
  assert.equal(declarations('overlays.css', '.dialog-footer').display, 'flex');
  // the chat sub line (visual pass, round 3): the live line from its start, one column
  assert.equal(declarations('chat.css', '.chat-sub')['grid-template-columns'], 'minmax(0, 1fr)');
  assert.equal(declarations('chat.css', '.chat-live')['grid-column'], '1');
  assert.equal(declarations('chat.css', '.chat-head-text')['grid-template-columns'], 'minmax(0, 1fr)', 'a long chat name ends in an ellipsis');
  // one fixed avatar cell: the chat name starts at the same x in a 1:1 and a group
  assert.equal(declarations('chat.css', '.chat-head-avatar').width, '36px');
  // the composer's action row: Ultra and the model chip keep one width whatever they show, so a pick moves nothing
  assert.equal(declarations('composer.css', '.ultra-switch').width, '52px');
  assert.equal(declarations('composer.css', '.model-chip').width, '148px');
  const ui = path.resolve(STYLES, '..');
  const chat = readFileSync(path.join(ui, 'chat', 'ChatHeader.tsx'), 'utf8');
  assert.match(chat, /<div class="chat-sub"[ >]/, 'one sub line for every chat, always reserved');
});

test('the lint sees what it must refuse', () => {
  const sample = '.a.selected { font-weight: 600 } .b[aria-pressed=true] .c { padding: 4px } .d:has(.e) { min-height: 26px } .f.on { color: red } body:has(.mobile-shell) .g { width: 10px }';
  const hits = styleRules(sample).flatMap((rule) => splitList(rule.selector)
    .filter((selector) => STATE.test(selector) && rule.declarations.some((item) => SIZE.test(item.property))));
  assert.deepEqual(hits, ['.a.selected', '.b[aria-pressed=true] .c', '.d:has(.e)']);
});
