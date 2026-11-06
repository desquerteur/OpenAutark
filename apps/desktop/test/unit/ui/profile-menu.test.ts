// B-072 the profile menu (owner 04.11.2026: "unten auf dem Profilbild ... kann dann die Account switchen", "einen neuen
// Account erstellen"): in the desktop window it lists the companies on this PC (the current one ticked) above Settings;
// B-078 (owner 06.11.2026): a "+" beside the company name offers New company / Connect as my other device / Join a
// company as employee, each a companies.open with its start; picking one calls companies.open (main opens that window
// and sends this one to the tray). The list is loaded when the bubble mounts and again on each opening, so the fixed-width menu opens at its
// full height; the PWA and phones never ask for it. No new icons.
// Owns: these assertions on the source (a .tsx file cannot run under node --test). Never: renders or calls a runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../src/ui');
const source = readFileSync(path.join(UI, 'shell', 'ProfileMenu.tsx'), 'utf8');

test('the companies come from companies.list, only in the desktop window', () => {
  assert.match(source, /if \(platform !== 'desktop'\) return;[^\n]*\n\s*rpc\.call\('companies\.list'\)/, 'the PWA and phones never ask');
  assert.match(source, /useEffect\(loadCompanies, \[\]\)/, 'loaded when the bubble mounts');
  assert.match(source, /onClick=\{\(\) => \{ if \(!open\) loadCompanies\(\); setOpen\(!open\); \}\}/, 'and again on each opening');
  assert.match(source, /const companies = signal<CompanyEntry\[\]>\(\[\]\)/, 'kept between openings: the menu opens at its full height');
});

test('one section: the companies (the current one ticked), then Settings; B-078: the "+" beside the company name adds one three ways', () => {
  assert.match(source, /checked: company\.current/);
  assert.match(source, /if \(!company\.current\) openCompany\(\{ id: company\.id \}\)/, 'picking the current one does nothing');
  assert.match(source, /\{ label: 'New company', [^\n]*openCompany\(\{ create: true, start: 'new' \}\) \}/);
  assert.match(source, /\{ label: 'Connect as my other device', [^\n]*openCompany\(\{ create: true, start: 'mine' \}\) \}/);
  assert.match(source, /\{ label: 'Join a company as employee', [^\n]*openCompany\(\{ create: true, start: 'employee' \}\) \}/);
  assert.match(source, /<IconButton icon="plus" label="Add a company"[^\n]*onClick=\{\(\) => \{ setOpen\(false\); setAdding\(true\); \}\}/, 'the "+" opens the add menu in the same place');
  assert.match(source, /<Menu anchor=\{ref\.current\} open=\{adding\}[^\n]*sections=\{\[\{ items: ADD_ITEMS \}\]\}/);
  assert.match(source, /rpc\.call\('companies\.open', params\)\.catch\(\(error: unknown\) => toastError\(error, 'Could not open the company'\)\)/);
  assert.match(source, /if \(!list\.length\) return \[\];/, 'no list (a test profile): no section');
  assert.match(source, /sections=\{\[\.\.\.companySections\(companies\.value\), \{ items: ITEMS \}\]\}/, 'Settings stays last');
  assert.match(source, /const ITEMS: MenuItem\[\] = \[\n  \{ label: 'Settings', hint: comboLabel\('mod\+,'\), onSelect: \(\) => go\.settings\(\) \},/);
  assert.match(source, /\.\.\.\(isPhoneApp\(\) \? \[\{ label: 'Forget this phone', [^\n]*onSelect: forgetThisPhone \}\] : \[\]\),/, 'B-078: only inside a phone app (Android or the iPhone web app)');
});

test('nothing shifts and no new icons: the same fixed-width popover', () => {
  assert.match(source, /width=\{256\}/);
  assert.doesNotMatch(source, /icon:/, 'menu items stay text only');
  assert.doesNotMatch(source, /<Icon\b/);
});
