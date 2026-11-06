// Owns: address scheme/credential checks shared by the UI and native browser.
// Never: connects to a website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserUrl } from '../../../src/shared/api/workspace-browser.ts';

test('workspace addresses accept web URLs and supply HTTPS for bare hosts', () => {
  assert.equal(browserUrl(' example.com/docs '), 'https://example.com/docs');
  assert.equal(browserUrl('localhost:3000/test'), 'https://localhost:3000/test');
  assert.equal(browserUrl('http://127.0.0.1:8080/next?q=one#two'), 'http://127.0.0.1:8080/next?q=one#two');
  assert.equal(browserUrl('https://example.com/@name?q=a@b'), 'https://example.com/@name?q=a@b');
});

test('workspace addresses reject privileged schemes and embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///C:/test', 'app://app/index.html', 'wf-sandbox://test', 'mailto:a@b.com', 'https://user:secret@example.com', 'https://user@example.com', 'https://example.com\\@other.com']) {
    assert.throws(() => browserUrl(url), url);
  }
});

test('workspace addresses reject empty, oversized and whitespace-separated input', () => {
  for (const url of ['', '   ', 'https://', 'a'.repeat(8193), 'example.com another.com', 'https://example.com/\nfile']) assert.throws(() => browserUrl(url));
});
