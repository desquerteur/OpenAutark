// Lexical query expansion (knowledge/query-rewrite.ts):
//  - light stems, ID tokens as typed, the DE/EN vocabulary and an exact phrase per multi-part ID in
//    the FTS expression (a superset of the old token query – every old token stays);
//  - the expansion lets the knowledge store find an inflected word, the other language and an exact
//    ID ahead of rows that share only one part of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandQuery, idTokens, stem } from '../../../src/runtime/knowledge/query-rewrite.ts';
import { ftsQuery } from '../../../src/runtime/knowledge/normalize.ts';
import { Db } from '../../../src/runtime/db/database.ts';
import { migrate } from '../../../src/runtime/db/migrate.ts';
import { ManualClock } from '../../../src/runtime/system/clock.ts';
import { KnowledgeStore } from '../../../src/runtime/knowledge/service.ts';

test('stems, ID tokens and the expansion keep every token of the old query', () => {
  assert.equal(stem('rechnungen'), 'rechnung');
  assert.equal(stem('meetings'), 'meeting');
  assert.equal(stem('rendering'), 'render');
  assert.equal(stem('abc12345'), 'abc12345', 'no stems of IDs');
  assert.deepEqual(idTokens('Where is INV-2024-0042 and run_8f3k2? Order 1234567, not v2'), ['INV-2024-0042', 'run_8f3k2', '1234567']);
  const expanded = expandQuery('Rechnungen INV-2024-0042');
  assert.ok(expanded.match!.startsWith('"inv 2024 0042" OR '), expanded.match);
  for (const part of ftsQuery('Rechnungen INV-2024-0042')!.split(' OR ')) assert.ok(expanded.match!.includes(part), `keeps ${part}`);
  assert.ok(expanded.added.includes('rechnung'));
  assert.ok(!expanded.added.includes('invoice'), 'the ID part "inv"* already finds invoice');
  assert.deepEqual(expandQuery('Rechnungen').added, ['rechnung', 'invoice']);
  assert.equal(expandQuery('und oder').match, undefined, 'stopwords only: nothing to search');
});

test('the knowledge store finds an inflected word, the other language and the exact ID first', async () => {
  const db = new Db(':memory:');
  migrate(db);
  const store = new KnowledgeStore({ db, clock: new ManualClock() });
  const exact = store.save({ scope: 'global', kind: 'fact', title: 'Invoice INV-2024-0042', body: 'Paid by bank transfer.', createdBy: 'human' });
  store.save({ scope: 'global', kind: 'fact', title: 'Budget 2024', body: 'The 2024 budget is 40k; item 0042 is the camera.', createdBy: 'human' });
  const english = store.save({ scope: 'global', kind: 'fact', title: 'Customer invoices', body: 'Send every invoice within a week.', createdBy: 'human' });
  const ids = (hits: Array<{ item: { id: string } }>) => hits.map((hit) => hit.item.id);
  assert.equal(ids(await store.search({ text: 'INV-2024-0042' }))[0], exact.id, 'the exact ID ranks first');
  assert.ok(ids(await store.search({ text: 'Rechnungen' })).includes(english.id), 'German plural finds the English note');
  db.close();
});
