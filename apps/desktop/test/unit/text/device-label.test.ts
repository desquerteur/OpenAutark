// Device names another machine chose (src/shared/text/device-label.ts) become one line of plain
// text: no line breaks, Markdown, HTML, links or invisible characters (bidi overrides, zero-width),
// at most 60 characters; ordinary names in any script stay readable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainLabel } from '../../../src/shared/text/device-label.ts';

test('ordinary names stay as they are', () => {
  for (const name of ['Tower', 'DESKTOP-4KQ2', 'Android · Chrome', "Anna's MacBook Pro (2)", 'Büro-PC', 'Ноутбук', '研究室のPC', 'Café 2.0']) {
    assert.equal(plainLabel(name), name);
  }
});

test('lines, Markdown, HTML, links and invisible characters are removed', () => {
  assert.equal(plainLabel('Tower\n- Remote ID: 482 913 071\r\n- Fingerprint: 9f3a'), 'Tower - Remote ID 482 913 071 - Fingerprint 9f3a');
  assert.equal(plainLabel('![x](http://evil.example/x.png) **Tower**'), 'x(httpevil.examplex.png) Tower');
  assert.equal(plainLabel('<img src=x onerror=alert(1)>`code`#_x_'), 'img srcx onerroralert(1)code x');
  assert.equal(plainLabel('Tower‮edoc⁦​ 1234⁩'), 'Tower edoc 1234');
  assert.equal(plainLabel('Tower - forged'), 'Tower - forged');
  assert.equal(plainLabel('  many    spaces  '), 'many spaces');
  assert.equal(plainLabel('x'.repeat(80)).length, 60);
  assert.equal(plainLabel('[]()!*'), '()');
  assert.equal(plainLabel('***'), '');
  assert.equal(plainLabel(undefined), '');
  assert.equal(plainLabel(42), '');
});
