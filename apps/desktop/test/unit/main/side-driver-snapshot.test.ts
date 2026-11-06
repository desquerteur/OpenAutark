// B-055 F1: the side tab as an agent reads it (main/side-driver/snapshot.ts) – the accessibility tree as
// Playwright-like lines with refs s<backendDOMNodeId>, states, link addresses without secret query values,
// hidden password values, no wrapper noise, the length cap; find; and the change list between two looks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changeList, diffLines, findLines, maskUrl, refOf, snapshotLines, type AXNode } from '../../../src/main/side-driver/snapshot.ts';
import { checkoutTree } from './side-driver-fakes.ts';

test('snapshot: roles, names, states, refs and nesting like Playwright', () => {
  const nav: AXNode[] = [
    { nodeId: 'n', role: { value: 'navigation' }, name: { value: '' }, backendDOMNodeId: 30, childIds: ['g'] },
    { nodeId: 'g', role: { value: 'generic' }, name: { value: '' }, parentId: 'n', childIds: ['l'] },
    { nodeId: 'l', role: { value: 'link' }, name: { value: 'Home' }, parentId: 'g', backendDOMNodeId: 31, childIds: ['lt'], properties: [{ name: 'url', value: { value: 'https://shop.example/' } }] },
    { nodeId: 'lt', role: { value: 'StaticText' }, name: { value: 'Home' }, parentId: 'l', backendDOMNodeId: 32 },
  ];
  const snap = snapshotLines(checkoutTree(nav), { origin: 'https://shop.example' });
  assert.deepEqual(snap.lines, [
    '- heading "Your cart" [level=1] [ref=s10]',
    '- textbox "Email" [ref=s20]: ann@example.com',
    '- textbox "Password" [ref=s21]: [hidden]',
    '- checkbox "Keep me signed in" [checked] [ref=s22]',
    '- link "Terms" [url=/terms?session=hidden&lang=en] [ref=s23]',
    '- button "Pay" [ref=s24]',
    '- navigation [ref=s30]',
    '  - link "Home" [url=/] [ref=s31]',
  ]);
  assert.deepEqual(snap.refs.get('s24'), { role: 'button', name: 'Pay' });
  assert.equal(snap.cut, false);
  assert.equal(refOf(snap.lines[5]!), 's24');
});

test('snapshot: ignored and generic nodes give way to their children; text merges; secret values never show', () => {
  const nodes: AXNode[] = [
    { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: 'x' }, childIds: ['i', 'p', 'pw', 'pin', 'd'] },
    { nodeId: 'i', ignored: true, role: { value: 'generic' }, parentId: 'r', childIds: ['b'] },
    { nodeId: 'b', role: { value: 'button' }, name: { value: 'Save' }, parentId: 'i', backendDOMNodeId: 5, properties: [{ name: 'disabled', value: { value: true } }, { name: 'expanded', value: { value: false } }] },
    { nodeId: 'p', role: { value: 'paragraph' }, name: { value: '' }, parentId: 'r', backendDOMNodeId: 6, childIds: ['t1', 's', 't3'] },
    { nodeId: 't1', role: { value: 'StaticText' }, name: { value: 'Total' }, parentId: 'p', backendDOMNodeId: 7 },
    { nodeId: 's', role: { value: 'strong' }, name: { value: '' }, parentId: 'p', childIds: ['t2'] },
    { nodeId: 't2', role: { value: 'StaticText' }, name: { value: '42 EUR' }, parentId: 's', backendDOMNodeId: 8 },
    { nodeId: 't3', role: { value: 'StaticText' }, name: { value: ' incl. VAT' }, parentId: 'p', backendDOMNodeId: 9 },
    { nodeId: 'pw', role: { value: 'textbox' }, name: { value: 'New key' }, parentId: 'r', backendDOMNodeId: 40, value: { value: 'hunter2' }, childIds: ['pwt'] },
    { nodeId: 'pwt', role: { value: 'StaticText' }, name: { value: 'hunter2' }, parentId: 'pw' },
    { nodeId: 'pin', role: { value: 'textbox' }, name: { value: 'PIN' }, parentId: 'r', backendDOMNodeId: 41, value: { value: '1234' } },
    { nodeId: 'd', role: { value: 'generic' }, name: { value: '' }, parentId: 'r', childIds: ['dt'] },
    { nodeId: 'dt', role: { value: 'StaticText' }, name: { value: 'Clickable card' }, parentId: 'd', backendDOMNodeId: 50 },
  ];
  const lines = snapshotLines(nodes, { secret: new Set([40]) }).lines;
  assert.deepEqual(lines, [
    '- button "Save" [expanded=false] [disabled] [ref=s5]',
    '- paragraph [ref=s6]: Total 42 EUR incl. VAT',
    '- textbox "New key" [ref=s40]: [hidden]',
    '- textbox "PIN" [ref=s41]: [hidden]',
    '- text [ref=s50]: Clickable card',
  ]);
  assert.ok(!lines.join('\n').includes('hunter2'), 'a password field’s inner text is never a text line');
});

test('snapshot: a label’s text beside the field it names is no extra line; a <select>’s popup gives way to its options', () => {
  const nodes: AXNode[] = [
    { nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: ['l', 's'] },
    { nodeId: 'l', role: { value: 'LabelText' }, name: { value: '' }, parentId: 'r', childIds: ['lt', 'tb'] },
    { nodeId: 'lt', role: { value: 'StaticText' }, name: { value: 'Email' }, parentId: 'l', backendDOMNodeId: 3 },
    { nodeId: 'tb', role: { value: 'textbox' }, name: { value: 'Email' }, parentId: 'l', backendDOMNodeId: 4 },
    { nodeId: 's', role: { value: 'combobox' }, name: { value: 'Country' }, value: { value: 'Austria' }, parentId: 'r', backendDOMNodeId: 5, childIds: ['p'] },
    { nodeId: 'p', role: { value: 'MenuListPopup' }, name: { value: '' }, parentId: 's', childIds: ['o'] },
    { nodeId: 'o', role: { value: 'MenuListOption' }, name: { value: 'Austria' }, parentId: 'p', backendDOMNodeId: 6, properties: [{ name: 'selected', value: { value: true } }] },
  ];
  assert.deepEqual(snapshotLines(nodes).lines, ['- textbox "Email" [ref=s4]', '- combobox "Country" [ref=s5]: Austria', '  - option "Austria" [selected] [ref=s6]']);
});

test('snapshot: a long page is cut with a pointer to find', () => {
  const nodes: AXNode[] = [{ nodeId: 'r', role: { value: 'RootWebArea' }, name: { value: '' }, childIds: [] }];
  for (let n = 0; n < 500; n += 1) {
    nodes[0]!.childIds!.push(`b${n}`);
    nodes.push({ nodeId: `b${n}`, role: { value: 'button' }, name: { value: `Button number ${n}` }, parentId: 'r', backendDOMNodeId: 1000 + n });
  }
  const snap = snapshotLines(nodes, { max: 2000 });
  assert.equal(snap.cut, true);
  assert.ok(snap.lines.join('\n').length <= 2000);
  assert.match(snap.lines[snap.lines.length - 1]!, /cut at 2000 characters; use find/);
});

test('maskUrl: secret query values and user info never show; data and javascript addresses are short', () => {
  assert.equal(maskUrl('https://ann:pw@a.example/x?token=abc&q=cats#k'), 'https://a.example/x?token=hidden&q=cats#k');
  assert.equal(maskUrl('https://a.example/cb#access_token=abc&state=1'), 'https://a.example/cb#hidden');
  assert.equal(maskUrl('https://a.example/x?q=1', 'https://a.example'), '/x?q=1');
  assert.match(maskUrl(`data:image/png;base64,${'A'.repeat(500)}`), /^data:… \(\d+ characters\)$/);
  assert.equal(maskUrl('javascript:alert(1)'), 'javascript:…');
});

test('find: every word over role, name and value, refs ignored, indentation gone', () => {
  const lines = snapshotLines(checkoutTree(), { origin: 'https://shop.example' }).lines;
  assert.deepEqual(findLines(lines, 'button pay').lines, ['- button "Pay" [ref=s24]']);
  assert.deepEqual(findLines(lines, 'ANN@EXAMPLE').lines, ['- textbox "Email" [ref=s20]: ann@example.com']);
  assert.deepEqual(findLines(lines, 's24').lines, [], 'a ref is no search word');
  const many = findLines(Array.from({ length: 50 }, (_, n) => `- button "B${n}" [ref=s${n}]`), 'button', 40);
  assert.equal(many.lines.length, 40);
  assert.equal(many.more, 10);
});

test('change list: added and removed lines, address and title; full when the document changed or almost all did', () => {
  const before = { lines: ['- button "Pay" [ref=s24]', '- text: Total 42 EUR'], url: 'https://shop.example/cart', title: 'Cart', doc: 1 };
  const after = { lines: ['- button "Pay" [disabled] [ref=s24]', '- text: Total 42 EUR', '- dialog "Paying…" [ref=s90]'], url: 'https://shop.example/cart#pay', title: 'Paying', doc: 1 };
  const out = changeList(before, after);
  assert.equal(out.full, false);
  assert.equal(out.text, [
    'Address: https://shop.example/cart#pay (was https://shop.example/cart)', 'Title: "Paying"',
    'Added:', '- button "Pay" [disabled] [ref=s24]', '- dialog "Paying…" [ref=s90]', 'Removed:', '- button "Pay" [ref=s24]',
  ].join('\n'));
  assert.deepEqual(changeList(before, before), { text: 'No visible changes.', full: false });
  assert.equal(changeList(undefined, after).full, true, 'a first look is the whole snapshot');
  assert.equal(changeList(before, { ...after, doc: 2 }).full, true, 'another document');
  const many = { ...before, lines: Array.from({ length: 60 }, (_, n) => `- text: line ${n}`) };
  assert.equal(changeList(many, { ...many, lines: Array.from({ length: 60 }, (_, n) => `- text: other ${n}`) }).full, true, 'almost everything changed');
  assert.match(changeList(before, before, 'confirm "Delete?"').text, /^Dialog: confirm "Delete\?" – press Enter to accept or Escape to dismiss it\./);
  assert.deepEqual(diffLines(['  - a', '- a', '- b'], ['- a', '- c']), { added: ['- c'], removed: ['- a', '- b'] });
});
