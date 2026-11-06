// The live view's picture and toolbar in the side pane (workspace-chrome.css, B-076 review): the cascade is read like
// the browser does (the matching rules of the file, highest specificity, then the later one) – zoomed (2x), the picture of
// a remote tab and of an agent's tab in the pane's sized column is twice the view's width with no cap, so one finger
// pans it; at 1x it is letterboxed into the view. Under a touch pointer the pane's live toolbar is as tall as every other
// tab's address row (48 px), and the PC's mark narrows with the pane's own width (a container query), not the screen's.
// Owns: these static checks of workspace-chrome.css. Never: renders (test/ui does).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compounds, splitList, styleRules } from './css-rules.ts';

const STYLES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui/styles');
const chrome = readFileSync(path.join(STYLES, 'workspace-chrome.css'), 'utf8');
const bare = chrome.replace(/\/\*[\s\S]*?\*\//g, '');

interface El { tag: string; classes: string[] }
/** Elements from the outside in, each written `tag.class.class`. */
const pathOf = (...items: string[]): El[] => items.map((item) => { const [tag, ...classes] = item.split('.'); return { tag: tag || 'div', classes }; });

/** A plain compound (`tag.class…`) on an element; anything with pseudo-classes or attributes counts as not matching. */
function fits(compound: string, el: El): boolean {
  if (/[:[#*]/.test(compound)) return false;
  const [tag, ...classes] = compound.split('.');
  return (!tag || tag === el.tag) && classes.every((name) => el.classes.includes(name));
}

/** Every combinator read as a descendant one: more rules match than in the browser, never fewer. */
function matches(selector: string, els: El[]): boolean {
  const parts = compounds(selector);
  if (!fits(parts.at(-1)!, els.at(-1)!)) return false;
  let at = els.length - 2;
  for (let i = parts.length - 2; i >= 0; i--) {
    while (at >= 0 && !fits(parts[i]!, els[at]!)) at--;
    if (at < 0) return false;
    at--;
  }
  return true;
}

const specificity = (selector: string): number => compounds(selector).reduce((sum, part) => sum + (part.match(/\./g)?.length ?? 0) * 100 + (/^[a-z]/i.test(part) ? 1 : 0), 0);

/** The value of `property` the cascade gives the last element of `els` from this file. */
function winner(els: El[], property: string): string | undefined {
  let best: { spec: number; value: string } | undefined;
  for (const rule of styleRules(chrome)) {
    const value = rule.declarations.filter((item) => item.property === property).at(-1)?.value;
    if (value === undefined) continue;
    for (const selector of splitList(rule.selector)) {
      if (!matches(selector, els)) continue;
      const spec = specificity(selector);
      if (!best || spec >= best.spec) best = { spec, value }; // later rules win a tie
    }
  }
  return best?.value;
}

const REMOTE = ['div.workspace-pane', 'div.workspace-body.tab-browser.remote-browser', 'div.workspace-screen.remote-web', 'div.workspace-screen-view.remote-web-view'];
const AGENT = ['div.workspace-pane', 'div.workspace-body.tab-browser.agent-browser', 'div.workspace-screen', 'div.workspace-screen-view'];
const TODO = ['div.workspace-screen', 'div.workspace-screen-view'];

test('zoomed, the picture is twice the view wide with no cap (one finger pans it); at 1x it is letterboxed into the view', () => {
  for (const [name, around] of [['remote tab', REMOTE], ['agent tab', AGENT], ['to-do', TODO]] as const) {
    const zoomed = pathOf(...around, 'div.browser-touch.browser-zoom', 'img');
    assert.equal(winner(zoomed, 'width'), '200%', name);
    assert.equal(winner(zoomed, 'max-width'), 'none', name);
    assert.equal(winner(zoomed, 'max-height'), 'none', name);
  }
  for (const around of [REMOTE, AGENT]) {
    const fit = pathOf(...around, 'div.browser-touch', 'img');
    assert.equal(winner(fit, 'max-width'), 'min(100cqw, var(--frame-w))');
    assert.equal(winner(fit, 'max-height'), 'min(100cqh, var(--frame-h))');
  }
});

test('the pane\'s live toolbar is the address row\'s height under a touch pointer; the PC mark narrows with the pane, not the screen', () => {
  assert.match(bare, /@media \(pointer: coarse\) \{ \.workspace-pane \.browser-live-toolbar \{ height: 48px; \} \}/);
  assert.match(bare, /\.remote-web \{ container: remote-web \/ inline-size; \}/);
  assert.match(bare, /@container remote-web \(max-width: \d+px\) \{\s*\.remote-web-mark \{ width: 28px;[^}]*\}\s*\.remote-web-pc \{ display: none; \}/);
  assert.doesNotMatch(bare, /@media[^{]*max-width[^{]*\{[^@]*\.remote-web-mark/, 'no viewport query sizes the mark');
  const mark = styleRules(chrome).find((rule) => rule.selector === '.remote-web-mark');
  assert.equal(mark?.declarations.find((item) => item.property === 'width')?.value, '136px', 'a fixed cell: the name arriving moves nothing');
});
