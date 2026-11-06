// To-do titles from ask blocks say what to do, not just the widget name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { titleForBlock } from '../../../src/runtime/tasks/widgets.ts';

test('checklist and form titles come from their content', () => {
  assert.equal(titleForBlock({ type: 'checklist', items: ['Charge the camera', { text: 'Clean the desk' }, 'Close other apps'] }), 'Charge the camera, Clean the desk +1');
  assert.equal(titleForBlock({ type: 'form', fields: [{ name: 'company', label: 'Company name' }, { name: 'vat' }] }), 'Company name, vat');
  assert.equal(titleForBlock({ type: 'checklist', items: [] }), 'Checklist');
  assert.equal(titleForBlock({ type: 'form', fields: 'nonsense' }), 'Fill in');
  assert.equal(titleForBlock({ type: 'choice', question: 'Which thumbnail?', options: ['A'] }), 'Which thumbnail?', 'an explicit text still wins');
});
