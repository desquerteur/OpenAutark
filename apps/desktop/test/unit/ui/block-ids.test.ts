// "Same id ⇒ update in place" (ui/blocks/ids.ts): a later agent or system block with the same id
// collapses the earlier one; a person's, a bridged contact's or an external agent's message
// never collapses an agent's ask or approval block (C8).
// Owns: these assertions only. Never: rendering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSuperseded, registerMessageIds } from '../../../src/ui/blocks/ids.ts';

test('only agents and the system update a block in place; external authors and the person never collapse it', () => {
  const chat = 'cnv_block_ids';
  registerMessageIds({ conversationId: chat, seq: 3, authorKind: 'agent' }, [{ id: 'approve-deploy', index: 0 }]);
  for (const [seq, authorKind] of [[4, 'external'], [5, 'human']] as const) {
    registerMessageIds({ conversationId: chat, seq, authorKind }, [{ id: 'approve-deploy', index: 0 }]);
    assert.equal(isSuperseded(chat, 'approve-deploy', 3, 0), false, `${authorKind} must not collapse the agent's block`);
  }
  registerMessageIds({ conversationId: chat, seq: 6, authorKind: 'agent' }, [{ id: 'approve-deploy', index: 0 }]);
  assert.equal(isSuperseded(chat, 'approve-deploy', 3, 0), true, 'the agent\'s own update collapses it');
  assert.equal(isSuperseded(chat, 'approve-deploy', 6, 0), false, 'the newest stays open');
  registerMessageIds({ conversationId: chat, seq: 7, authorKind: 'system' }, [{ id: 'approve-deploy', index: 0 }]);
  assert.equal(isSuperseded(chat, 'approve-deploy', 6, 0), true);
});
