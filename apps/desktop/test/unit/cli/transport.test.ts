// C7: the wf client's transport against the runtime's real HttpServer and /ws handshake
// (test/unit/http/fixture.ts, fake RPC behind it): Node's global WebSocket with the launch token
// gets owner scope over loopback, a token the runtime does not know is refused (4401 → forbidden,
// exit 3), and a runtime shutting down ends open streams as unreachable (exit 5).
// Owns: these assertions only. Never: starts the real runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../../../src/runtime/wf-cli/client.ts';
import { Endpoint } from '../../../src/runtime/wf-cli/discover.ts';
import { exitCodeOf, type CliError } from '../../../src/runtime/wf-cli/errors.ts';
import { LAUNCH_TOKEN, fixture } from '../http/fixture.ts';

test('the launch token from runtime.json gets owner scope over loopback; requests right after the Hello are served', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const rpc = await connect(new Endpoint({ dataDir: f.root, port, token: LAUNCH_TOKEN }));
    const [first, second] = await Promise.all([rpc.call('chats.list'), rpc.call('agents.list', { includeArchived: true })]);
    assert.deepEqual(first, { method: 'chats.list', scope: 'owner' });
    assert.deepEqual(second, { method: 'agents.list', scope: 'owner' });
    assert.deepEqual(f.rpc.attached.map((entry) => entry.scope), [{ kind: 'owner' }]);
    rpc.close();
  } finally {
    await f.close();
  }
});

test('a token the runtime does not know is refused: the call fails as forbidden (exit 3)', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const rpc = await connect(new Endpoint({ dataDir: f.root, port, token: 'stale-token-from-an-earlier-start-000000' }));
    await assert.rejects(rpc.call('chats.list'), (error: CliError) => error.kind === 'forbidden' && exitCodeOf(error.kind) === 3);
    assert.equal(f.rpc.attached.length, 0);
  } finally {
    await f.close();
  }
});

test('the runtime shutting down: the connection is lost as unreachable (exit 5)', async () => {
  const f = fixture();
  try {
    const { port } = await f.server.listen();
    const rpc = await connect(new Endpoint({ dataDir: f.root, port, token: LAUNCH_TOKEN }));
    await rpc.call('events.subscribe', { topics: ['tasks'] });
    const lost = rpc.lost;
    await f.server.close();
    const error = await lost;
    assert.equal(error.kind, 'unreachable');
    assert.equal(exitCodeOf(error.kind), 5);
    await assert.rejects(rpc.call('chats.list'), (failure: CliError) => failure.kind === 'unreachable');
  } finally {
    await f.close();
  }
});
