// B-047 CORE-CODE wiring, checked in the source of the composition root (building it needs every service):
// the sign-in work (accounts/relogin.ts) is created, set as services.relogin – which turn failures reach through
// recordAccountFailure(services, …) – and watches the bus; the evidence checker is set as services.evidence for the
// verifier; accounts.sign_in is registered with the built-in tools and web.search comes with web.fetch.
// Owns: these assertions only. Never: builds the core or reaches the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinTools } from '../../../src/runtime/tools/builtin/index.ts';

const source = (file: string) => readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');

test('services.ts wires the relogin service and the evidence checker', () => {
  const services = source('src/runtime/compose/services.ts');
  assert.match(services, /const relogin = new Relogin\(\{ services \}\);\n\s+s\.relogin = relogin;\n\s+relogin\.watch\(\);/);
  assert.match(services, /s\.evidence = createEvidenceChecker\(\);/);
  // Turn failures pass the whole services record, so services.relogin reaches failure.ts.
  assert.match(source('src/runtime/agents/turn.ts'), /recordAccountFailure\(services, turn\.account/);
});

test('the built-in tools include accounts.sign_in and web.search', () => {
  const names = builtinTools().map((tool) => tool.name);
  assert.ok(names.includes('accounts.sign_in'));
  assert.ok(names.includes('web.search'));
  assert.ok(names.indexOf('web.search') === names.indexOf('web.fetch') + 1, 'web.search comes with web.fetch');
});
