// Test setup for the context ledger (B-048 E1): the chat harness (real chats, messages, bus), a real run
// journal that keeps long outputs in a real blob store (temp folder), a recording reclaim, a redacting secret
// port, and the ledger wired like compose/services.ts does (start(): bus listeners).
// Owns: fixtures only. Never imported by src/.

import { agent, harness } from '../chat/harness.ts';
import { tempDir } from '../store/helpers.ts';
import { Blobs } from '../../../src/runtime/files/store.ts';
import { Journal } from '../../../src/runtime/runs/journal.ts';
import { ContextLedgerService } from '../../../src/runtime/context/ledger/service.ts';
import { journalResult } from '../../../src/runtime/tools/journal.ts';
import type { RuntimeServices } from '../../../src/runtime/contracts.ts';

export const redact = (text: string): string => text.replace(/sk-[a-z0-9]{8,}/g, 'secret://key');

/** The journal's keepOutput as compose/services.ts wires it: only runs the ledger captures, stored in `files`. */
export function keepFor(files: Blobs, ledger: () => ContextLedgerService | undefined) {
  return async (text: string, name: string, runId: string) =>
    (ledger()?.holds(runId) ? (await files.put(new TextEncoder().encode(text), `${name}-output.txt`, 'text/plain')).id : undefined);
}

export function ledgerSetup(options: { budget?: number } = {}) {
  const h = harness();
  const tom = h.org.add(agent('ag_tom', 'Tom'));
  const chat = h.chats.create({ agentIds: [tom.id], createdBy: 'human' });
  const dir = tempDir('wf-ledger-');
  const files = new Blobs({ db: h.db, blobs: dir.dir, clock: h.clock, log: h.services.log });
  const reclaimed: string[] = [];
  (files as unknown as { reclaim: (ids: Iterable<string>) => void }).reclaim = (ids) => { reclaimed.push(...ids); };
  let ledger: ContextLedgerService | undefined;
  const journal = new Journal({ db: h.db, bus: h.bus, clock: h.clock, keepOutput: keepFor(files, () => ledger) });
  Object.assign(h.services, {
    runs: journal, files, secrets: { redact },
    settings: { get: () => ({ profile: { name: 'Alex', timezone: 'UTC' } }) },
  });
  ledger = new ContextLedgerService({ services: () => h.services, budget: options.budget });
  (h.services as RuntimeServices).ledger = ledger;
  const stop = ledger.start();
  let runs = 0;
  /** A run of Tom in the chat, attached to the ledger like a turn attempt does. */
  const turn = (seenSeq = 0, engine = 'codex', model = 'openai:gpt-5.5') => {
    const runId = `run_${++runs}`;
    journal.start({ id: runId, agentId: tom.id, conversationId: chat.id, trigger: 'message' });
    ledger.capture({ runId, agentId: tom.id, conversationId: chat.id, engine, model, seenSeq });
    return runId;
  };
  /** One of our tool calls as the registry journals it (tool_call, then the result through tools/journal.ts). */
  const ourCall = (runId: string, name: string, args: Record<string, unknown>, output: string, callId = `call_${Math.random().toString(36).slice(2, 8)}`) => {
    journal.item(runId, { kind: 'tool_call', name, data: { callId, args: JSON.stringify(args), summary: `${name} ${Object.values(args).join(' ')}`.trim() }, effectStatus: 'none', idemKey: `${runId}:${callId}` });
    journalResult(h.services, runId, name, callId, `${runId}:${callId}`, { content: [{ type: 'text', text: output }] }, []);
    return callId;
  };
  const say = (body: string) => h.chats.send({ conversationId: chat.id, authorId: 'human', body });
  const done = (runId: string) => journal.finish(runId, { status: 'done' });
  return { ...h, tom, chat, files, journal, ledger, reclaimed, turn, ourCall, say, done, cleanup: () => { stop(); dir.cleanup(); } };
}
