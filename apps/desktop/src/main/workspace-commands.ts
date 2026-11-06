// What the app window may ask the person's browser (main/workspace-browser.ts): every argument of its IPC checked
// before anything runs – a known action, a tab id of the browser's own form (every action but list, layout and reopen
// names one), an address string to open, a space, a viewport with finite sizes for a show, the find text, a layout of
// spaces (workspace-tabs.ts checks its entries).
// Owns: these checks. Never: imports electron or acts on a tab.

import { isSpace, type BrowserBounds, type WorkspaceBrowserCommand } from '../shared/api/workspace-browser.ts';
import { CHROME_ACTIONS } from './workspace-chrome.ts';

const TAB_ID = /^web-[a-zA-Z0-9-]{1,80}$/;
const ACTIONS = new Set(['list', 'layout', 'open', 'close', 'show', 'hide', 'keep', 'back', 'forward', 'reload', 'stop', 'reveal', 'reopen', ...CHROME_ACTIONS]);
const FLAG = (value: unknown) => value === undefined || typeof value === 'boolean';

export function tabId(value: unknown): string {
  if (typeof value !== 'string' || !TAB_ID.test(value)) throw new Error('Invalid browser tab.');
  return value;
}

export function browserCommand(value: unknown): WorkspaceBrowserCommand {
  if (!value || typeof value !== 'object') throw new Error('Invalid browser command.');
  const item = value as Record<string, unknown>;
  if (!ACTIONS.has(String(item.action))) throw new Error('Invalid browser command.');
  if (item.action === 'layout') {
    if (!item.spaces || typeof item.spaces !== 'object' || Array.isArray(item.spaces)) throw new Error('Invalid browser command.');
    return item as unknown as WorkspaceBrowserCommand;
  }
  if (item.action === 'reopen') {
    if (!isSpace(item.space)) throw new Error('Invalid browser space.');
    return item as unknown as WorkspaceBrowserCommand;
  }
  if (item.action === 'zoom' && item.step !== 1 && item.step !== -1 && item.step !== 0) throw new Error('Invalid browser command.');
  if (item.action !== 'list') tabId(item.id);
  if (item.action === 'open' && typeof item.url !== 'string') throw new Error('Enter a website address.');
  if (item.action === 'open' && item.space !== undefined && !isSpace(item.space)) throw new Error('Invalid browser space.');
  if (item.action === 'find' && (typeof item.text !== 'string' || !FLAG(item.next) || !FLAG(item.forward))) throw new Error('Invalid browser command.');
  if (item.action === 'show') {
    const box = item.bounds as BrowserBounds | undefined;
    if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width < 1 || box.height < 1) throw new Error('Invalid browser viewport.');
  }
  return item as unknown as WorkspaceBrowserCommand;
}
